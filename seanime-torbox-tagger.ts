/// <reference path="./types/core.d.ts" />
/// <reference path="./types/system.d.ts" />
/// <reference path="./types/app.d.ts" />
/// <reference path="./types/plugin.d.ts" />

type TorrentIdPayload = {
    torrentItemId?: string | number
}

type PlaybackPayload = {
    filename?: string
    readyAt?: number
}

type SeanimeDebridTorrent = Omit<$ui.DebridTorrentItem, "addedAt"> & {
    // Seanime 3.10.0 returns `added` at runtime although its declaration says `addedAt`.
    added?: string
    addedAt?: string
}

type TorBoxTorrent = {
    id?: string | number
    tags?: unknown[]
}

type TorBoxResponse<T = unknown> = {
    success?: boolean
    detail?: string
    data?: T
}

type TorBoxTagger = {
    getSafeErrorMessage(error: unknown): string
    getStreamFilename(streamURL: string): string
    pendingTorrentKey: string
    streamReadyKey: string
    tagPlaybackStream(ctx: $ui.Context, payload?: PlaybackPayload): Promise<void>
    tagTorrent(ctx: $ui.Context, payload?: TorrentIdPayload): Promise<void>
}

function init() {
    $shared.define<TorBoxTagger>("torboxTagger", () => {
        const apiBase = "https://api.torbox.app/v1/api"
        const tag = "seanime"
        const pendingTorrentKey = "torbox-tagger:pending-torrent"
        const streamReadyKey = "torbox-tagger:stream-ready"
        const retryDelaysMs = [500, 1500]
        const playbackLookupDelaysMs = [0, 500, 1500, 3000]

        class TorBoxTaggerError extends Error {
            readonly retryable: boolean

            constructor(message: string, retryable: boolean) {
                super(message)
                this.name = "TorBoxTaggerError"
                this.retryable = retryable
            }
        }

        function isObject(value: unknown): value is Record<string, unknown> {
            return value !== null && typeof value === "object"
        }

        function isRetryableStatus(status: number): boolean {
            return status === 404 || status === 429 || status >= 500
        }

        function getResponseDetail(payload: unknown, fallback: string): string {
            if (isObject(payload) && typeof payload.detail === "string" && payload.detail.trim()) {
                return payload.detail.trim()
            }
            return fallback
        }

        function getSafeErrorMessage(error: unknown): string {
            if (isObject(error) && typeof error.message === "string" && error.message.trim()) {
                return error.message.trim()
            }
            return "Unknown TorBox API error"
        }

        function parseTorrentId(value: unknown): number | undefined {
            const id = typeof value === "number" ? value : Number(value)
            return Number.isSafeInteger(id) && id > 0 ? id : undefined
        }

        function getTorrentAddedTimestamp(torrent?: SeanimeDebridTorrent): number {
            if (!torrent) {
                return Number.NaN
            }

            const value = torrent.added || torrent.addedAt
            return typeof value === "string" ? Date.parse(value) : Number.NaN
        }

        function getStreamFilename(streamURL: string): string {
            const match = streamURL.match(/[?&]filename=([^&]+)/i)
            if (!match) {
                return ""
            }

            try {
                return decodeURIComponent(match[1].replace(/\+/g, " "))
            } catch (_error) {
                return match[1]
            }
        }

        function normalizeTorrentName(value: unknown): string {
            return typeof value === "string"
                ? value.toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\s._-]+/g, "")
                : ""
        }

        function namesMatch(torrentName: unknown, filename: string): boolean {
            const left = normalizeTorrentName(torrentName)
            const right = normalizeTorrentName(filename)
            return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)))
        }

        function isTorBoxEnabled(ctx: $ui.Context): boolean {
            const settings = ctx.debrid.getSettings()
            return Boolean(
                settings
                && settings.enabled
                && settings.provider.toLowerCase() === "torbox",
            )
        }

        function findTorrent(data: unknown, torrentId: number): TorBoxTorrent | undefined {
            if (Array.isArray(data)) {
                return data.find((item: unknown) => isObject(item) && Number(item.id) === torrentId) as TorBoxTorrent | undefined
            }
            if (!isObject(data)) {
                return undefined
            }
            return data.id === undefined || Number(data.id) === torrentId ? data : undefined
        }

        function wait(ctx: $ui.Context, milliseconds: number): Promise<void> {
            return new Promise((resolve) => {
                ctx.setTimeout(() => resolve(), milliseconds)
            })
        }

        async function requestTorBox<T = unknown>(
            ctx: $ui.Context,
            apiKey: string,
            url: string,
            options: $ui.FetchOptions = {},
        ): Promise<TorBoxResponse<T>> {
            let response: $ui.FetchResponse
            try {
                response = await ctx.fetch(url, {
                    ...options,
                    headers: {
                        ...options.headers,
                        Authorization: `Bearer ${apiKey}`,
                    },
                    noCloudflareBypass: true,
                    timeout: 5,
                })
            } catch (error) {
                throw new TorBoxTaggerError(getSafeErrorMessage(error), true)
            }

            let payload: TorBoxResponse<T> | undefined
            try {
                payload = response.json<TorBoxResponse<T>>()
            } catch (_error) {
                payload = undefined
            }

            if (!response.ok || payload?.success !== true) {
                const status = Number(response.status) || 0
                throw new TorBoxTaggerError(
                    getResponseDetail(payload, `TorBox API request failed with status ${status}`),
                    isRetryableStatus(status),
                )
            }

            return payload
        }

        async function tagTorrentOnce(ctx: $ui.Context, apiKey: string, torrentId: number): Promise<boolean> {
            const listUrl = `${apiBase}/torrents/mylist?id=${encodeURIComponent(String(torrentId))}&bypass_cache=true`
            const listPayload = await requestTorBox<TorBoxTorrent | TorBoxTorrent[]>(ctx, apiKey, listUrl, {
                method: "GET",
            })
            const torrent = findTorrent(listPayload.data, torrentId)

            if (!torrent) {
                throw new TorBoxTaggerError("TorBox torrent is not available yet", true)
            }

            const existingTags = Array.isArray(torrent.tags)
                ? torrent.tags.filter((item): item is string => typeof item === "string" && item.length > 0)
                : []

            if (existingTags.includes(tag)) {
                return false
            }

            await requestTorBox(ctx, apiKey, `${apiBase}/torrents/edittorrent`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: {
                    torrent_id: torrentId,
                    tags: [...existingTags, tag],
                },
            })

            return true
        }

        async function tagTorrent(ctx: $ui.Context, payload?: TorrentIdPayload): Promise<void> {
            const torrentId = parseTorrentId(payload?.torrentItemId)
            if (torrentId === undefined) {
                console.warn("[TorBox Tagger] Ignoring an invalid torrent item ID")
                return
            }

            const settings = ctx.debrid.getSettings()
            const provider = settings?.provider.toLowerCase() || ""
            const apiKey = settings?.apiKey.trim() || ""

            if (!settings?.enabled || provider !== "torbox") {
                return
            }

            if (!apiKey) {
                console.warn(`[TorBox Tagger] TorBox API key is unavailable; torrent ${torrentId} was not tagged`)
                return
            }

            for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
                try {
                    const changed = await tagTorrentOnce(ctx, apiKey, torrentId)
                    if (changed) {
                        console.log(`[TorBox Tagger] Added tag "${tag}" to torrent ${torrentId}`)
                    } else {
                        console.log(`[TorBox Tagger] Torrent ${torrentId} already has tag "${tag}"`)
                    }
                    return
                } catch (error) {
                    const canRetry = error instanceof TorBoxTaggerError
                        && error.retryable
                        && attempt < retryDelaysMs.length
                    if (!canRetry) {
                        const safeMessage = getSafeErrorMessage(error).split(apiKey).join("[redacted]")
                        console.error(`[TorBox Tagger] Failed to tag torrent ${torrentId}: ${safeMessage}`)
                        return
                    }
                    await wait(ctx, retryDelaysMs[attempt])
                }
            }
        }

        async function getDebridTorrents(ctx: $ui.Context): Promise<SeanimeDebridTorrent[]> {
            try {
                const torrents = await ctx.debrid.getTorrents()
                return Array.isArray(torrents) ? torrents as SeanimeDebridTorrent[] : []
            } catch (error) {
                console.warn(`[TorBox Tagger] Could not inspect debrid torrents: ${getSafeErrorMessage(error)}`)
                return []
            }
        }

        async function tagPlaybackStream(ctx: $ui.Context, payload?: PlaybackPayload): Promise<void> {
            if (!isTorBoxEnabled(ctx)) {
                return
            }

            const readyAt = Number(payload?.readyAt)
            if (!Number.isFinite(readyAt)) {
                return
            }

            const filename = typeof payload?.filename === "string" ? payload.filename : ""
            console.log("[TorBox Tagger] Looking up the TorBox torrent used by playback")

            for (const delayMs of playbackLookupDelaysMs) {
                if (delayMs > 0) {
                    await wait(ctx, delayMs)
                }

                const candidates = (await getDebridTorrents(ctx))
                    .map((item) => ({ item, addedAt: getTorrentAddedTimestamp(item) }))
                    .sort((left, right) => {
                        const leftTimestamp = Number.isFinite(left.addedAt) ? left.addedAt : 0
                        const rightTimestamp = Number.isFinite(right.addedAt) ? right.addedAt : 0
                        return rightTimestamp - leftTimestamp
                    })
                const recent = candidates.filter(({ addedAt }) => (
                    Number.isFinite(addedAt) && addedAt >= readyAt - 120000
                ))
                const nameMatch = filename
                    ? candidates.find(({ item }) => namesMatch(item.name, filename))
                    : undefined
                const selected = nameMatch || recent[0]
                const torrentId = parseTorrentId(selected?.item.id)

                if (torrentId !== undefined) {
                    await tagTorrent(ctx, { torrentItemId: torrentId })
                    return
                }
            }

            console.warn("[TorBox Tagger] Could not identify a TorBox torrent for playback")
        }

        return {
            getSafeErrorMessage,
            getStreamFilename,
            pendingTorrentKey,
            streamReadyKey,
            tagPlaybackStream,
            tagTorrent,
        }
    })

    $ui.register((ctx) => {
        const tagger = $shared.use<TorBoxTagger>("torboxTagger")
        console.log("[TorBox Tagger] UI handler ready (v0.5.1)")

        $store.watch<TorrentIdPayload>(tagger.pendingTorrentKey, (payload) => {
            tagger.tagTorrent(ctx, payload).catch((error: unknown) => {
                console.error(`[TorBox Tagger] Unexpected tagging failure: ${tagger.getSafeErrorMessage(error)}`)
            })
        })

        $store.watch<PlaybackPayload>(tagger.streamReadyKey, (payload) => {
            tagger.tagPlaybackStream(ctx, payload).catch((error: unknown) => {
                console.error(`[TorBox Tagger] Unexpected playback tagging failure: ${tagger.getSafeErrorMessage(error)}`)
            })
        })
    })

    $app.onDebridAddTorrent((event) => {
        const tagger = $shared.use<TorBoxTagger>("torboxTagger")
        try {
            console.log(`[TorBox Tagger] Debrid torrent hook received ID ${event.torrentItemId}`)
            $store.set(tagger.pendingTorrentKey, {
                torrentItemId: event.torrentItemId,
            })
        } catch (error) {
            console.error(`[TorBox Tagger] Failed to queue torrent for tagging: ${tagger.getSafeErrorMessage(error)}`)
        } finally {
            event.next()
        }
    })

    $app.onDebridSendStreamToMediaPlayer((event) => {
        const tagger = $shared.use<TorBoxTagger>("torboxTagger")
        try {
            console.log("[TorBox Tagger] Debrid playback hook received")
            $store.set(tagger.streamReadyKey, {
                filename: tagger.getStreamFilename(event.streamURL),
                readyAt: Date.now(),
            })
        } catch (error) {
            console.error(`[TorBox Tagger] Failed to queue stream for tagging: ${tagger.getSafeErrorMessage(error)}`)
        } finally {
            event.next()
        }
    })
}
