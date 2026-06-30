# eez-ui — MCP server for authoring EEZ Studio Dashboard UI

An [MCP](https://modelcontextprotocol.io) server that lets Claude Code build EEZ
Studio **Dashboard** projects: create pages and widgets, declare and **map
variables**, wire up **EEZ Flow** (action components + connections + event
handlers), read the editor's **Checks** diagnostics, and **visualize** the
result.

Paired with the [`eez-ui-bridge`](../extension) plugin, edits are applied to the
**running** EEZ Studio editor and appear in your window in real time — through
the editor's own operations, so binding/validation/defaults behave exactly as if
you clicked. Without a running app, the authoring tools still work by editing the
`.eez-project` JSON directly.

## How it works

```
Claude Code ──(MCP stdio)──▶ server.js ──┬─ lib/backend.js  (picks a path per call)
                                          ├─ LIVE:  lib/bridge-client.js ──HTTP+token──▶ eez-ui-bridge
                                          │                                              (drives the running editor)
                                          └─ FILE:  lib/project.js  (edits .eez-project JSON; authoring only)
```

Results are tagged `"via":"live-editor"` or `"via":"file"`. The widget catalog
(`dashboard-widgets.schema.json`) and the new-project template
(`dashboard-template.eez-project`) are **shipped with the package** — no built
EEZ Studio checkout is required.

## Prerequisites

1. **Node 18+** (Claude Code launches the server; see Registration).
2. For live editing / `render` / `build` / `validate` / `get_checks`: **EEZ
   Studio open** with the `eez-ui-bridge` plugin installed
   (`node ../extension/install.mjs`, then restart EEZ Studio).

## Tools

| Tool | Needs app? | Purpose |
|------|:---------:|---------|
| `create_dashboard_project(path, [displayWidth, displayHeight])` | no | New Dashboard from the template; becomes active (opened live if the app is running) |
| `open_project(path)` | no | Set an existing project active (opened live if running) |
| `list_widget_types([kind])` / `get_widget_schema(type)` | no | Browse the shipped component catalog |
| `add_page` / `list_pages` | no\* | Pages |
| `add_widget` / `update_widget` / `delete_widget` / `list_widgets` | no\* | Widgets (returns objIDs) |
| `add_variable` / `list_variables` | no\* | Global variables |
| `bind_widget(page, objID, expression)` | no\* | Map a widget's `data` to a variable/expression |
| `add_action_component` / `add_event_handler` / `connect` / `disconnect` / `list_connections` | no\* | EEZ Flow |
| `save()` | no\* | Persist the running editor's project (no-op in file mode) |
| `get_checks()` | **yes** | EEZ Studio's **Checks** diagnostics: `{errors, warnings, checks:[{type, message, location, objID}]}` |
| `render(page, [mode=design\|run])` | **yes** | **Returns a PNG** of the page (the live window) |
| `build()` | **yes** | Build/compile; returns `{success, output}` |
| `validate()` | **yes** | Load + re-serialize to confirm the project is well-formed |

\* Applied **live** when the app is open, else to the `.eez-project` file. All
tool calls are serialized so overlapping calls can't corrupt the project.

### Key conventions

- **Expressions** (`data`, `bind_widget`): a bare name is a variable reference
  (`counter`); quoted text is a literal (`"\"hi\""`); numbers/booleans are
  literals (`42`, `true`).
- **Variable types**: `integer`, `float`, `double`, `boolean`, `string`,
  `date`, `json`, `any`, or `enum:Name` / `struct:Name` / `array:T`.
- **Flow pins**: widget event outputs (`CLICKED`), action sequence pins
  (`@seqout` → `@seqin`), or named data pins. `connect` references components by
  `objID` (returned from `add_widget` / `add_action_component`).

## Example session

```
create_dashboard_project(path="C:/tmp/demo.eez-project")
add_page(name="Main")
add_variable(name="counter", type="integer", defaultValue="0")
add_widget(page="Main", type="TextDashboardWidget", left=20, top=20, width=220, height=30, data="counter")
btn = add_widget(page="Main", type="ButtonDashboardWidget", left=20, top=70, width=160, height=44, data="\"Increment\"")
add_event_handler(page="Main", objID=btn, eventName="CLICKED")
act = add_action_component(page="Main", type="SetVariableActionComponent", left=260, top=70,
                           props={ entries: [{ variable: "counter", value: "counter + 1" }] })
connect(page="Main", source=btn, output="CLICKED", target=act, input="@seqin")
get_checks()                         # see any diagnostics, fix by objID
render(page="Main", mode="design")   # the editor layout + flow graph
render(page="Main", mode="run")      # the live board
build()                              # verify it compiles
```

## Registration

Run Claude Code from the repo root to pick up the included [`.mcp.json`](../.mcp.json)
(`{ "mcpServers": { "eez-ui": { "command": "node", "args": ["mcp/server.js"] } } }`).
`node` must be on PATH; if it isn't (e.g. managed by fnm/nvm), replace `"node"`
with the absolute path to your Node 18+ binary. To use it from other projects,
copy that entry into a user- or project-level MCP config with an absolute path
to `mcp/server.js`.

Environment variables (optional):

- `EEZ_WIDGET_SCHEMA` — path to a widget catalog (defaults to the shipped one).
- `EEZ_BRIDGE_URL` + `EEZ_BRIDGE_TOKEN` — override live-bridge discovery instead
  of reading the discovery file; `EEZ_BRIDGE_DISCOVERY` overrides its path.

## Modes & limitations

- **Live mode** needs EEZ Studio open with the plugin. Live edits stay in memory
  until `save()` (or `build`/`validate`, which flush first), so the editor shows
  an unsaved-changes indicator — by design, like manual editing.
- **File mode** (no app) supports authoring only; `render`/`build`/`validate`/
  `get_checks` return a clear "needs EEZ Studio running" error.
- The catalog covers **built-in** Dashboard components for the shipped EEZ Studio
  version; regenerate after an upgrade (point `EEZ_WIDGET_SCHEMA` at a fresh dump).
- Run-mode render captures the runtime viewer region (some surrounding
  whitespace). No `remove_variable` / `remove_page` yet.

## Tests

- `npm test` — fast **unit** suite (`node:test`) for `lib/project.js`,
  `lib/bridge-client.js`, and `lib/backend.js` (file-mode routing). No app, no
  Electron; this is the CI gate.
- `npm run test:mcp` — drives the server over stdio like a real client (needs EEZ
  Studio open with the plugin for the live `render`/`build`/`validate`/`get_checks`
  steps).

## License

Part of `eez-ui-mcp`; GPL-3.0-only (see the repository `LICENSE`).
