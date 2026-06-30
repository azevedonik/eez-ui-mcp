# eez-ui-mcp

Author EEZ Studio **Dashboard** UI from Claude Code — **live, in the running
editor**. Ask Claude to build a screen and the widgets, variables, data
bindings, and flow connections appear in your EEZ Studio window in real time
(vibe-coding), with full undo. Claude can also read the editor's **Checks**
diagnostics and render the page to verify its work.

Two parts:

| Folder | What it is |
|--------|------------|
| [`extension/`](extension) | **`eez-ui-bridge`** — an EEZ Studio *project-editor extension* (plugin) that hosts a localhost control bridge inside the running app. Plain JS, zero dependencies. |
| [`mcp/`](mcp) | **`eez-ui`** — the [MCP](https://modelcontextprotocol.io) server Claude Code talks to. It drives the editor through the bridge (and edits `.eez-project` JSON directly as a no-app fallback for authoring). |

## How it works

```
Claude Code ──(MCP stdio)──▶ mcp/server.js ──HTTP 127.0.0.1 (+token)──▶ eez-ui-bridge
                                                                          (in the running EEZ Studio)
                                                                          │ drives the editor's own
                                                                          ▼ operations, live
                                                            add widget/variable/binding/connection,
                                                            render, get_checks, build, validate
```

The plugin reaches the app's live `ProjectStore` via Node's module resolution
(EEZ Studio registers `build/` as a global module root), so **no changes to EEZ
Studio and no custom build are required** — it works against a stock install.

## Quick start

1. **Install the plugin** into EEZ Studio (any 0.28.x install):
   ```
   node extension/install.mjs        # then restart EEZ Studio
   ```
   (Or unzip `extension/dist/eez-ui-bridge-*.zip` into EEZ Studio's user-data
   `extensions/` folder — see [extension/README.md](extension/README.md).)

2. **Register the MCP** with Claude Code — point it at `mcp/server.js` (see
   [mcp/README.md](mcp/README.md)). A ready-to-use [`.mcp.json`](.mcp.json) is
   included for running Claude Code from this repo.

3. **Open a Dashboard project** in EEZ Studio and ask Claude to build UI.

## Requirements

- **EEZ Studio 0.28.x** installed (the plugin runs inside it).
- **Node 18+** to run the MCP server.

No build of EEZ Studio is needed. Authoring tools work without the app too (they
edit the `.eez-project` JSON); `render` / `build` / `validate` / `get_checks`
require the app to be open with the plugin.

## License

GPL-3.0-only. The plugin loads EEZ Studio's modules at runtime, so it is a
derivative work of EEZ Studio (GPL-3.0); this whole repository is distributed
under the same license. See [LICENSE](LICENSE).
