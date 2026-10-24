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
| `create_dashboard_project(path, [displayWidth, displayHeight])` | no | New Dashboard from the template; becomes active (opened live if the app is running); reports `studioVersion` / `bridgeVersion` |
| `open_project(path)` | no | Set an existing project active (opened live if running); reports `studioVersion` / `bridgeVersion` |
| `list_widget_types([kind])` / `get_widget_schema(type)` | no | Browse the shipped component catalog |
| `add_page` / `list_pages` | no\* | Pages |
| `add_widget` / `update_widget` / `delete_widget` / `list_widgets` | no\* | Widgets (returns objIDs) |
| `add_variable` / `list_variables` | no\* | Global variables |
| `bind_widget(page, objID, expression)` | no\* | Map a widget's `data` to a variable/expression |
| `add_action_component` / `add_event_handler` / `connect` / `disconnect` / `list_connections` | no\* | EEZ Flow |
| `batch(ops, [project])` | no\* | Apply **many authoring ops in one call**, all-or-nothing (see [Batching](#batching)) |
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

## Batching

Building a screen one op per tool call is slow: the real latency is Claude's
turn per call, not the bridge (a call takes a few ms). `batch` applies a whole
sequence of authoring ops in a **single** tool call.

```
batch({ project?, ops: [{ tool, args, as? }, ...] })
```

- `ops`: 1-200 entries, run in order. `tool` is one of `add_page`,
  `add_widget`, `add_action_component`, `update_widget`, `delete_widget`,
  `add_variable`, `bind_widget`, `add_event_handler`, `connect`,
  `disconnect`. `args` are that tool's normal arguments (without `project`).
- **Aliases**: an op that creates a component (`add_widget`,
  `add_action_component`) may set `as: "btn"`. Later ops can then pass
  `"$btn"` as `objID`, `source` or `target`, and it is replaced with the
  created component's objID. No other field is substituted; an undefined,
  forward-referencing or duplicate alias is rejected before anything is applied.
- **All-or-nothing**: every op is validated up front, then applied as one unit.
  Live, the whole batch is **one undo step** in the editor (and is rolled back if
  an op fails); in file mode it is one save, written only if every op succeeded.
  A failure returns `batch op #k (tool) failed: ...; nothing applied`.
- The result is `{ via, applied, results:[{index, tool, as?, ...}], refs:{btn:"<objID>"} }`.

```
batch(ops=[
  { tool: "add_page", args: { name: "Main" } },
  { tool: "add_widget", as: "label", args: { page: "Main", type: "TextDashboardWidget",
      left: 20, top: 20, width: 220, height: 30, data: "\"Hello\"" } },
  { tool: "add_widget", as: "btn", args: { page: "Main", type: "ButtonDashboardWidget",
      left: 20, top: 70, width: 160, height: 44, data: "\"Go\"" } },
  { tool: "add_event_handler", args: { page: "Main", objID: "$btn", eventName: "CLICKED" } },
  { tool: "add_action_component", as: "act", args: { page: "Main",
      type: "SetVariableActionComponent", left: 260, top: 70, props: { entries: [] } } },
  { tool: "connect", args: { page: "Main", source: "$btn", output: "CLICKED",
      target: "$act", input: "@seqin" } }
])
```

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

### Errors when the live editor is involved

Each call picks live or file mode (see [How it works](#how-it-works)); failures
fall into three classes:

- **Bridge not reachable** (no discovery file, EEZ Studio not running, connection
  refused): the request was never delivered, so authoring tools fall back to the
  `.eez-project` file (`"via":"file"`).
- **Delivered but no answer** (timeout / connection reset after the request was
  sent): the editor **may have applied the op**. The call fails with that
  message and does **not** fall back to the file (that could apply it twice);
  check the result with `list_*` before retrying.
- **Bridge answered with an error** (e.g. HTTP 401): the op was **not
  applied**, with no file fallback, since the project is likely open in the
  editor. On 401 the bridge rejected the token (the MCP re-reads it from the
  discovery file on every call): restart EEZ Studio, or fix
  `EEZ_BRIDGE_URL`/`EEZ_BRIDGE_TOKEN` if set, then retry.

### Version reporting

`open_project` and `create_dashboard_project` return `studioVersion` (the
running EEZ Studio) and `bridgeVersion` (the installed `eez-ui-bridge`). If the
installed bridge is older than this MCP expects, the result carries a
`warning`; fix it with `node extension/install.mjs` and restart EEZ Studio.

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
  `lib/bridge-client.js`, `lib/backend.js` (routing) and the bridge's live ops.
  No app, no Electron.
- `npm run test:mcp` — **live smoke test**: drives the server over stdio like a
  real client (needs EEZ Studio open with the plugin for the live
  `render`/`build`/`validate`/`get_checks`/`batch` steps).

## License

Part of `eez-ui-mcp`; GPL-3.0-only (see the repository `LICENSE`).
