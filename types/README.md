# Seanime type declarations

Seanime does not publish these declarations as an npm package. The files are synced from the Seanime repository at tag `v3.10.0`:

```text
internal/extension_repo/goja_plugin_types/
```

They are kept byte-for-byte unchanged so VS Code can provide completion and diagnostics for the plugin globals. The exact upstream commit and SHA-256 hashes are recorded in `.sync-meta.json`.

Refresh them reproducibly with:

```bash
npm run sync:types
```

Pass `-- --ref <tag-or-commit>` to intentionally move to another Seanime version. Runtime differences are described by small compatibility types in `seanime-torbox-tagger.ts` rather than by editing the upstream declarations.
