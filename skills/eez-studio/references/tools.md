# eez-ui MCP tool reference (v0.4.0)

`project` is optional on every project-scoped tool: it defaults to the project
made active by `open_project` / `create_dashboard_project`. "Live only" tools
need EEZ Studio open with eez-ui-bridge; the rest work live or on the file.

## Project lifecycle

| Tool | Args | Returns |
|------|------|---------|
| `create_dashboard_project` | `path` (absolute), `displayWidth?`, `displayHeight?` | `{ created, active, live, studioVersion?, bridgeVersion?, warning? }`. Opens it in Studio when live. New projects include a `default` style, so they start with zero check errors. |
| `open_project` | `path` | `{ active, projectType, via, studioVersion?, bridgeVersion?, warning? }`. Opens/reloads the tab when live. |

## Catalog (no app needed)

| Tool | Args | Returns |
|------|------|---------|
| `list_widget_types` | `kind?`: `all` \| `widget` \| `actionComponent` | Component type names |
| `get_widget_schema` | `type` | Properties of that component (name, type), defaults |

Widgets: `TextDashboardWidget`, `ButtonDashboardWidget`, `TextInputWidget`,
`NumberInputDashboardWidget`, `CheckboxWidget`, `SwitchDashboardWidget`,
`SliderDashboardWidget`, `DropDownListDashboardWidget`, `SelectWidget`,
`RadioWidget`, `ProgressDashboardWidget`, `GaugeWidget`, `LineChartWidget`,
`EEZChartWidget`, `PlotlyWidget`, `TabulatorWidget`, `ListWidget`, `GridWidget`,
`ContainerWidget`, `RectangleDashboardWidget`, `BitmapDashboardWidget`,
`MarkdownWidget`, `QRCodeDashboardWidget`, `SpinnerWidget`, `TerminalWidget`,
`InstrumentTerminalWidget`, `EmbeddedDashboardWidget`, `UserWidgetWidget`.

Common action components: `SetVariableActionComponent` (`entries:[{variable, value}]`),
`ShowPageActionComponent`, `EvalExprActionComponent`, `LogActionComponent`,
`DelayActionComponent`, `CompareActionComponent`, `IsTrueActionComponent`,
`SwitchActionComponent`, `LoopActionComponent`, `CounterActionComponent`,
`StartActionComponent`, `EndActionComponent`, `CallActionActionComponent`,
`WatchVariableActionComponent`, `HTTP`, `JSONParse`, `JSONStringify`, `FileRead`,
`FileWrite`, `SerialConnect`/`SerialWrite`/`SerialRead`, `TCPConnect`/`TCPWrite`,
`MQTTConnectActionComponent`/`MQTTPublishActionComponent`/`MQTTSubscribeActionComponent`,
`SCPIActionComponent`, `ModbusActionComponent`. Run `list_widget_types` for the
full list (~100) and `get_widget_schema` before setting props on any of them.

## Pages, widgets, variables

| Tool | Args | Returns |
|------|------|---------|
| `add_page` | `name`, `width?` (480), `height?` (272) | `{ added }` |
| `list_pages` | — | `{ pages }` |
| `add_widget` | `page`, `type`, `left`, `top`, `width`, `height`, `data?` (expression), `props?` | `{ objID, warning? }` |
| `update_widget` | `page`, `objID`, `props` (no `objID`/`type`) | `{ updated }` |
| `delete_widget` | `page`, `objID` (also removes its connection lines) | `{ deleted }` |
| `list_widgets` | `page` | `{ widgets:[{ objID, type, left, top, width, height, data, … }] }` |
| `add_variable` | `name`, `type?`, `defaultValue?` (expression), `description?`, `persistent?` | `{ added, type, defaultValue }` |
| `list_variables` | — | `{ variables }` |
| `bind_widget` | `page`, `objID`, `expression` | `{ bound, data, warnings? }` (live warns on unknown variables) |

## EEZ Flow

| Tool | Args | Returns |
|------|------|---------|
| `add_action_component` | `page`, `type`, `left`, `top`, `width?`, `height?`, `props?` | `{ objID }` |
| `add_event_handler` | `page`, `objID`, `eventName?` (e.g. `CLICKED`), `handlerType?` (`flow` default \| `action`), `action?` (named action when `action`) | `{ widget, eventName, handlerType }` |
| `connect` | `page`, `source`, `output`, `target`, `input` (pins: `CLICKED`, `@seqout`, `@seqin`, named data pins) | `{ connected, … }` |
| `disconnect` | same as `connect` | `{ removed }` (count) |
| `list_connections` | `page` | `{ connections:[{ source, output, target, input }] }` |

## Batch

`batch({ project?, ops:[{ tool, args, as? }] })` — see SKILL.md §3. 1–200 ops,
all-or-nothing, aliases `as` / `"$alias"` in `objID`/`source`/`target`.

## Verify and persist

| Tool | Live only | Args | Returns |
|------|:--:|------|---------|
| `get_checks` | yes | — | `{ errors, warnings, total, checks:[{ type, message, location, objID }] }` |
| `render` | yes | `page?`, `mode?` (`design` \| `run`) | PNG image of the page (design = canvas + flow graph, run = live board) |
| `build` | yes | — | `{ success, output }` (saves first) |
| `validate` | yes | — | `{ valid }` (load + re-serialize; saves first) |
| `save` | — | — | `{ via, saved }` (no-op in file mode: file edits are already on disk) |

## Environment variables (optional, set in the MCP registration)

- `EEZ_WIDGET_SCHEMA` — alternative widget catalog JSON.
- `EEZ_BRIDGE_URL` + `EEZ_BRIDGE_TOKEN` — talk to a bridge directly instead of
  reading the discovery file; `EEZ_BRIDGE_DISCOVERY` — alternative discovery file path.
