# Changelog

## 0.3.0

Standalone and **fork-free** — the MCP no longer needs a built EEZ Studio checkout.

- All app-backed operations run inside the running editor via the `eez-ui-bridge`
  plugin: `build` and `validate` now execute in-app (`store.build()` / a throwaway
  load+re-serialize), joining the existing live `render` and `get_checks`. The
  headless CLI path (`lib/eez-cli.js` and the `--*` harnesses) is removed.
- The widget catalog (`dashboard-widgets.schema.json`) and new-project template
  (`dashboard-template.eez-project`) ship with the package, so type discovery and
  `create_dashboard_project` need neither a build nor a running app.
- `render`/`build`/`validate`/`get_checks` require a running app (clear error
  otherwise); authoring keeps the no-app `.eez-project` JSON fallback.
- Repackaged as the standalone `eez-ui-mcp` repository (`extension/` + `mcp/`).

## 0.2.0

Live, UI-driven authoring against a running EEZ Studio (vibe-coding).

- New companion extension `eez-ui-bridge` (a project-editor `pext`) that hosts a
  token-guarded `127.0.0.1` control server inside the running editor and applies
  edits through the editor's own operations (`addObject`/`updateObject`/
  `connect`, palette defaults, `navigationStore.showObjects`), so widgets,
  variables, bindings and flow connections appear **live in the user's window**
  with undo support; `render` captures the live canvas (design + run).
- The MCP now picks a path per call (`lib/backend.js`): the live bridge when EEZ
  Studio is open with the extension, else the headless JSON + CLI path (kept as a
  fallback). Tool results are tagged `"via":"live-editor"` or `"via":"file"`.
- New `lib/bridge-client.js` (discovery file / `EEZ_BRIDGE_URL`+`EEZ_BRIDGE_TOKEN`
  override; transport-vs-opError classification so a closed app falls back but a
  real editor error is surfaced).
- New `save` tool; `build`/`validate` flush live edits to disk first. `render`
  no longer takes an `out` path (returns the image inline).
- New `get_checks` tool surfaces EEZ Studio's **Checks** panel diagnostics
  (errors/warnings with `location` + `objID`) so Claude can find and fix invalid
  references without a full build — live via the bridge, or in file mode via a
  new `--check-project` headless harness.
- Tests: added `node:test` units for `bridge-client` and `backend` fallback
  routing (no Electron) to the CI gate.

## 0.1.0

Initial release of the `eez-ui` MCP server for authoring EEZ Studio Dashboard
UI from Claude Code.

- Authoring tools: pages, widgets, variables (with data binding), and EEZ Flow
  (action components, event handlers, connections) over the documented
  `.eez-project` JSON format.
- Visualization: `render` (design + run modes) returns a PNG inline; `build`
  and `validate` verify the project via the built EEZ Studio app.
- Widget catalog generated on demand and cached (not committed); used for type
  discovery and pre-validation.
- Hardening: all tool calls serialized to avoid file races; reserved fields
  (`objID`/`type`) protected from `props`; variable types validated; headless
  harnesses report real process exit codes (sentinel-based) so failures are
  detected reliably; Electron child processes tree-killed on timeout and reaped
  on exit; temp render/validate files cleaned up.
- Tests: fast `node:test` unit suite for the pure library (`npm test`); plus
  integration and MCP-protocol smoke gates.
