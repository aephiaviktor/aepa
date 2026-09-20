# Offline Electron UI check

After compiling (`npm run build`), create an isolated staging directory containing:
- this folder's `main.cjs` and `preload.cjs`
- repository `ui/` and `assets/`
- `dist/src/automation-options.js`, `fleet-view.js`, and `copper-estimate.js`

Run an Electron executable against the staged `main.cjs`. It uses its own staged
`profile/`, mock IPC, no signer, no real database, and no chain transactions.
It writes `result.json` and `screenshot.png` alongside the entry point. A result
with `error` is a failure, even if a wrapper shell exits successfully.

Checks cover max-eight selection, counter, removable selected items, re-enabling
choices after deselection, destination intersection/removal warning, blocked
cross-system options, neutral labels, and saving/reloading the selected array.
The mock save verifies the renderer contract; real SQLite persistence and
validation are covered separately by the TypeScript suite.
