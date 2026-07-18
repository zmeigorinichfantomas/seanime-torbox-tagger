import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("../", import.meta.url)
const manifestText = await readFile(new URL("seanime-torbox-tagger.json", root), "utf8")
const manifest = JSON.parse(manifestText)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))

test("production manifest is safe to install from its public URL", () => {
    assert.equal(manifest.version, packageJson.version)
    assert.equal(manifest.payload, "")
    assert.equal(manifest.isDevelopment, undefined)
    assert.match(manifest.manifestURI, /^https:\/\/raw\.githubusercontent\.com\//)
    assert.match(manifest.payloadURI, /^https:\/\/raw\.githubusercontent\.com\//)
    assert.equal(manifestText.includes("/Users/"), false)
})
