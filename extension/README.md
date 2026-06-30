# eez-ui-bridge — live editor bridge for the eez-ui MCP

An EEZ Studio **project-editor extension (pext)** that lets the external
[`eez-ui`](../mcp) MCP server drive your **running** EEZ Studio editor.
With it installed, when Claude Code authors UI the widgets, variables, bindings
and flow connections appear **live in the window you're looking at** — the
vibe-coding loop — instead of editing a file on disk.

## How it works

```
eez-ui MCP  ──HTTP 127.0.0.1 (+token)──▶  eez-ui-bridge (this extension, in the renderer)
                                              │ drives the editor's OWN operations:
                                              ▼
                              projectStore.addObject / updateObject / deleteObject,
                              createObject (palette defaults), navigationStore.showObjects,
                              setRuntimeMode + webContents.capturePage (render)
```

- EEZ Studio loads extensions via `require(folder).default` and calls `init()`.
  Because the app registers `build/` as a global Node module root
  (app-module-path), this extension can `require("home/tabs-store")` /
  `require("project-editor/store")` and reach the **same live singletons** the
  editor uses. No changes to EEZ Studio's source are needed.
- `init()` starts a localhost HTTP control server **only in the renderer**
  (extensions also load in the main process; there is no editor there).
- Edits go through the editor's own operation layer, so binding/validation and
  defaults behave exactly as if you clicked, and MobX re-renders the canvas
  automatically. Compound edits are grouped into a single undo step.

## Install

The extension is plain JavaScript with **no dependencies** and needs no build,
so installing on **any** EEZ Studio (0.28.x) is just "put the folder in the
extensions directory". EEZ Studio loads every sub-folder of its user-data
`extensions/` directory at startup.

EEZ Studio's user-data `extensions/` directory:

| OS | Folder |
|----|--------|
| Windows | `%APPDATA%\eezstudio\extensions\` |
| macOS | `~/Library/Application Support/eezstudio/extensions/` |
| Linux | `~/.config/eezstudio/extensions/` |

**Option A — installer script** (resolves the folder for your OS and copies the
files into `extensions/eez-ui-bridge/`):

```
node install.mjs              # install / update
node install.mjs --uninstall  # remove
```

**Option B — distributable zip (use on any machine).** Build it with
`npm run pack` (produces `dist/eez-ui-bridge-<version>.zip` containing a
top-level `eez-ui-bridge/` folder), then on the target machine **unzip it into
the `extensions/` directory above** so you end up with
`…/extensions/eez-ui-bridge/index.js`.

**Option C — Extensions Manager (in-app).** Extensions → the **Extensions**
(project-editor) section → **Install Extension from local folder** → pick the
unzipped `eez-ui-bridge` folder. (This route yarn-links the folder, so it
requires `yarn`; Options A/B don't.)

Then **restart EEZ Studio**. To confirm it's live, check that the discovery file
`eez-ui-bridge.json` appears in your OS temp dir, or run any `eez-ui` MCP tool
and look for `"via":"live-editor"` in the result.

## Security

- The server binds to **127.0.0.1 only** and requires a per-session bearer token
  (`x-eez-bridge-token`) on every request except `/ping`. The token is written
  to the discovery file the MCP reads.
- Because the bridge can drive the editor, treat the token as sensitive. Closing
  EEZ Studio stops the server and removes the discovery file.
- Override the port with `EEZ_BRIDGE_PORT` (default `38011`).

## Endpoints

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /ping` | none | health check |
| `GET /status` | token | active project diagnostic |
| `POST /op` | token | `{ op, ...args }` — run an editor operation (see `live-ops.js`) |

## Uninstall

Delete the `eez-ui-bridge` folder from the extensions directory and restart.

## License

Part of EEZ Studio; GPL-3.0-only.
