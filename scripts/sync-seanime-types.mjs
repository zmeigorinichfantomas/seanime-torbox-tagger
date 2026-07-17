import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const repository = "5rahim/seanime"
const defaultRef = "v3.10.0"
const sourceDirectory = "internal/extension_repo/goja_plugin_types"
const filenames = ["core.d.ts", "system.d.ts", "app.d.ts", "plugin.d.ts"]
const typesDirectory = fileURLToPath(new URL("../types/", import.meta.url))

const refFlagIndex = process.argv.indexOf("--ref")
const requestedRef = refFlagIndex === -1 ? defaultRef : process.argv[refFlagIndex + 1]
if (!requestedRef) {
    throw new Error("--ref requires a tag, branch, or commit SHA")
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: { "User-Agent": "seanime-torbox-tagger-type-sync" },
    })
    if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${url}`)
    }
    return response.text()
}

async function resolveCommit(ref) {
    if (/^[a-f0-9]{40}$/i.test(ref)) {
        return ref.toLowerCase()
    }

    const response = await fetch(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "seanime-torbox-tagger-type-sync",
        },
    })
    if (!response.ok) {
        throw new Error(`Could not resolve Seanime ref "${ref}" (${response.status})`)
    }
    const payload = await response.json()
    if (!payload || typeof payload.sha !== "string") {
        throw new Error(`Seanime ref "${ref}" did not resolve to a commit`)
    }
    return payload.sha
}

const commit = await resolveCommit(requestedRef)
await mkdir(typesDirectory, { recursive: true })

const files = []
for (const filename of filenames) {
    const source = `${sourceDirectory}/${filename}`
    const url = `https://raw.githubusercontent.com/${repository}/${commit}/${source}`
    const content = await fetchText(url)
    await writeFile(new URL(`../types/${filename}`, import.meta.url), content)
    files.push({
        source,
        output: `types/${filename}`,
        sha256: createHash("sha256").update(content).digest("hex"),
    })
}

const metadata = {
    repository,
    requestedRef,
    commit,
    files,
}
await writeFile(
    new URL("../types/.sync-meta.json", import.meta.url),
    `${JSON.stringify(metadata, null, 2)}\n`,
)

console.log(`Synced ${files.length} Seanime type files from ${repository}@${commit}`)
