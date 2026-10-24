# Changelog

## 0.4.0

Faster authoring (`batch`), safer live routing, and EEZ Studio 0.29.0 support.

### Added

- **`batch` tool**: apply 1-200 authoring ops in one call (`add_page`,
  `add_widget`, `add_action_component`, `update_widget`, `delete_widget`,
  `add_variable`, `bind_widget`, `add_event_handler`, `connect`,
  `disconnect`), with `as` aliases / `"$alias"` substitution so later ops can
  reference components created earlier in the same batch. All-or-nothing: live it
  is a single undo step (rolled back on failure), in file mode a single save.
- **Version reporting**: the bridge reports `bridgeVersion` / `studioVersion`;
  `open_project` and `create_dashboard_project` return them and warn when the
  installed bridge is older than the MCP expects (`node extension/install.mjs` +
  restart EEZ Studio).

### Fixed

- UTF-8 corruption in bridge request bodies and responses (multi-byte characters
  split across chunks, e.g. long pt-BR labels).
- No silent double-apply on timeout: a request that was delivered but got no
  answer is reported as ambiguous ("may have applied, check with `list_*`")
  instead of being retried against the file. A bridge that answers with an error
  (e.g. stale token after a Studio restart) is surfaced as "not applied", also
  without file fallback.
- `update_widget` in live mode can no longer change `objID`/`type` (that
  rewrote the ID and broke connections); blocked in the MCP and in the bridge.
- New projects no longer start with `"Use style": "default" not found` check
  errors: the shipped template now includes the `default` style.
- Fast file fallback when the discovery file is stale (dead pid): no network call
  is attempted.

### Changed

- `mcp` version 0.4.0; dependency floors `@modelcontextprotocol/sdk` ^1.29.0 and
  `zod` ^3.25.0.
- The bridge's discovery file is written with mode 0600 (POSIX only; an existing
  file keeps its previous mode) and removed when EEZ Studio exits.
- Docs: supported EEZ Studio is now 0.28.x-0.29.x (tested on 0.29.0).

### EEZ Studio 0.29.0

Tested live against 0.29.0. That release changed no project-editor store, widget,
flow or extension APIs (only the lz4 dependency replaced by a vendored wasm in the
build, `eez-gui-lite` export helpers, serial-write integer arrays and LVGL
fixes), so no compatibility changes were needed.

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
