import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = ts.transpileModule(
    await readFile(new URL("../seanime-torbox-tagger.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
).outputText

function successResponse(data = undefined) {
    return {
        ok: true,
        status: 200,
        json: () => ({ success: true, detail: "OK", data }),
    }
}

function errorResponse(status, detail) {
    return {
        ok: false,
        status,
        json: () => ({ success: false, detail }),
    }
}

function createHarness({
    settings = {
        enabled: true,
        provider: "torbox",
        apiKey: "test-secret-token",
    },
    fetchImpl = async () => successResponse(),
    getTorrentsImpl = async () => [],
} = {}) {
    const watchers = new Map()
    const sharedModules = new Map()
    const calls = []
    const logs = []
    const hooks = {}

    const context = vm.createContext({
        console: {
            log: (...args) => logs.push(["log", ...args]),
            warn: (...args) => logs.push(["warn", ...args]),
            error: (...args) => logs.push(["error", ...args]),
        },
        queueMicrotask,
        $shared: {
            define(name, factory) {
                sharedModules.set(name, factory)
            },
            use(name) {
                const factory = sharedModules.get(name)
                assert.equal(typeof factory, "function", `shared module ${name} is defined`)
                return factory()
            },
        },
        $store: {
            watch(key, callback) {
                watchers.set(key, callback)
                return () => watchers.delete(key)
            },
            set(key, value) {
                const callback = watchers.get(key)
                if (callback) {
                    queueMicrotask(() => callback(value))
                }
            },
        },
        $ui: {
            register(callback) {
                callback({
                    debrid: {
                        getSettings: () => settings,
                        getTorrents: () => getTorrentsImpl(),
                    },
                    fetch: async (url, options) => {
                        calls.push({ url, options })
                        return fetchImpl(url, options)
                    },
                    setTimeout(callback) {
                        queueMicrotask(callback)
                        return () => {}
                    },
                })
            },
        },
        $app: {
            onDebridAddTorrent(callback) {
                hooks.addTorrent = callback
            },
            onDebridSendStreamToMediaPlayer(callback) {
                hooks.streamReady = callback
            },
        },
    })

    vm.runInContext(source, context, { filename: "seanime-torbox-tagger.ts" })
    context.init()

    return {
        calls,
        logs,
        triggerAdd(torrentItemId) {
            let nextCalls = 0
            hooks.addTorrent({
                torrentItemId,
                next() {
                    nextCalls += 1
                },
            })
            return () => nextCalls
        },
        triggerStreamReady(streamURL = "") {
            let nextCalls = 0
            hooks.streamReady({
                streamURL,
                next() {
                    nextCalls += 1
                },
            })
            return () => nextCalls
        },
    }
}

async function waitFor(predicate, message = "condition") {
    const deadline = Date.now() + 1000
    while (!predicate()) {
        if (Date.now() >= deadline) {
            assert.fail(`Timed out waiting for ${message}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
}

test("queues the hook, preserves tags, and calls TorBox edit", async () => {
    const harness = createHarness({
        fetchImpl: async (url) => url.endsWith("/edittorrent")
            ? successResponse()
            : successResponse({ id: 42, tags: ["existing"] }),
    })

    const getNextCalls = harness.triggerAdd("42")
    assert.equal(getNextCalls(), 1)

    await waitFor(() => harness.calls.length === 2, "GET and PUT requests")

    const [getCall, putCall] = harness.calls
    assert.match(getCall.url, /\/torrents\/mylist\?id=42&bypass_cache=true$/)
    assert.equal(getCall.options.method, "GET")
    assert.equal(getCall.options.headers.Authorization, "Bearer test-secret-token")
    assert.equal(putCall.url, "https://api.torbox.app/v1/api/torrents/edittorrent")
    assert.equal(putCall.options.method, "PUT")
    assert.equal(putCall.options.headers.Authorization, "Bearer test-secret-token")
    assert.deepEqual(
        JSON.parse(JSON.stringify(putCall.options.body)),
        { torrent_id: 42, tags: ["existing", "seanime"] },
    )
})

test("does not duplicate an existing seanime tag", async () => {
    const harness = createHarness({
        fetchImpl: async () => successResponse({ id: 7, tags: ["seanime", "existing"] }),
    })

    const getNextCalls = harness.triggerAdd(7)
    assert.equal(getNextCalls(), 1)
    await waitFor(() => harness.calls.length === 1, "torrent lookup")
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(harness.calls.length, 1)
})

test("skips unsupported settings and invalid torrent IDs without network calls", async (t) => {
    const cases = [
        {
            name: "different provider",
            settings: { enabled: true, provider: "realdebrid", apiKey: "secret" },
            torrentItemId: "10",
        },
        {
            name: "disabled debrid",
            settings: { enabled: false, provider: "torbox", apiKey: "secret" },
            torrentItemId: "10",
        },
        {
            name: "missing API key",
            settings: { enabled: true, provider: "torbox", apiKey: "" },
            torrentItemId: "10",
        },
        {
            name: "invalid torrent ID",
            settings: { enabled: true, provider: "torbox", apiKey: "secret" },
            torrentItemId: "not-a-number",
        },
    ]

    for (const item of cases) {
        await t.test(item.name, async () => {
            const harness = createHarness({ settings: item.settings })
            const getNextCalls = harness.triggerAdd(item.torrentItemId)
            assert.equal(getNextCalls(), 1)
            await new Promise((resolve) => setTimeout(resolve, 5))
            assert.equal(harness.calls.length, 0)
        })
    }
})

test("retries transient failures, never blocks the hook, and never logs the token", async () => {
    const apiKey = "super-secret-token"
    const harness = createHarness({
        settings: { enabled: true, provider: "torbox", apiKey },
        fetchImpl: async () => errorResponse(500, "Temporary TorBox failure"),
    })

    const getNextCalls = harness.triggerAdd("99")
    assert.equal(getNextCalls(), 1)

    await waitFor(
        () => harness.calls.length === 3 && harness.logs.some(([level]) => level === "error"),
        "retry exhaustion",
    )

    assert.equal(harness.calls.length, 3)
    assert.equal(harness.logs.flat().join(" ").includes(apiKey), false)
})

test("does not retry authentication failures", async () => {
    const harness = createHarness({
        fetchImpl: async () => errorResponse(403, "Authentication failed"),
    })

    const getNextCalls = harness.triggerAdd("123")
    assert.equal(getNextCalls(), 1)
    await waitFor(() => harness.logs.some(([level]) => level === "error"), "error log")
    assert.equal(harness.calls.length, 1)
})

test("tags a reused playback torrent by filename without a debridstream UI helper", async () => {
    const now = Date.now()
    const harness = createHarness({
        getTorrentsImpl: async () => [
            {
                id: "999",
                name: "Unrelated newer torrent",
                added: new Date(now).toISOString(),
            },
            {
                id: "512",
                name: "[SubsPlease] Example Episode 02 [1080p]",
                added: new Date(now - 60 * 60 * 1000).toISOString(),
            },
        ],
        fetchImpl: async (url) => url.endsWith("/edittorrent")
            ? successResponse()
            : successResponse({ id: 512, tags: ["existing"] }),
    })

    const getNextCalls = harness.triggerStreamReady(
        "https://cdn.example/video?token=private&filename=%5BSubsPlease%5D%20Example%20Episode%2002%20%5B1080p%5D.mkv",
    )
    assert.equal(getNextCalls(), 1)
    await waitFor(() => harness.calls.length === 2, "manual stream tagging")
    assert.deepEqual(
        JSON.parse(JSON.stringify(harness.calls[1].options.body)),
        { torrent_id: 512, tags: ["existing", "seanime"] },
    )
})
