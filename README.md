# Seanime TorBox Tagger

Adds the `seanime` tag to TorBox torrents created by Seanime, including debrid streams. Existing tags are preserved.

## Install

Add this manifest URL as a custom extension in Seanime:

```text
https://raw.githubusercontent.com/zmeigorinichfantomas/seanime-torbox-tagger/main/seanime-torbox-tagger.json
```

Use Seanime's URL installer; copying the manifest into the extensions directory does not download its payload.

Requires Seanime 3.10.0 or newer with TorBox configured as the debrid provider.

## Development

```sh
pnpm install
pnpm test && pnpm typecheck
```
