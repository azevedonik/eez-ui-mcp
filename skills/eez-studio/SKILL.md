---
name: eez-studio
description: Build and edit EEZ Studio Dashboard UIs (pages, widgets, variables, data bindings, EEZ Flow action components and connections) live in the running EEZ Studio editor through the eez-ui MCP, then verify with Checks, render and build. Use this skill whenever the user mentions EEZ Studio, EEZ Flow, an .eez-project file, a Dashboard project, the eez-ui MCP or eez-ui-bridge, or asks to create/design/wire a screen, panel, HMI or instrument UI in EEZ — even if they only say "make a screen with a button that…" while an .eez-project is involved. Also use it to install, update, troubleshoot or upgrade the eez-ui MCP, the bridge extension or EEZ Studio itself. Triggers in Portuguese too: "tela no EEZ", "criar dashboard no EEZ Studio", "conectar flow", "atualizar o MCP do EEZ".
---

# EEZ Studio Dashboard authoring (eez-ui MCP)

The `eez-ui` MCP lets you author EEZ Studio **Dashboard** projects. When EEZ
Studio is open with the `eez-ui-bridge` extension, every edit goes through the
editor's own operations and appears live in the user's window, with undo. When
the app is closed, authoring still works by editing the `.eez-project` JSON on
disk. Each result says which path it took: `"via":"live-editor"` or `"via":"file"`.

Two parts make this work, and both must be the same version:

| Part | What it is |
|------|------------|
| `eez-ui` MCP (`mcp/server.js`) | Node stdio server Claude Code talks to |
| `eez-ui-bridge` extension | Runs inside EEZ Studio, hosts a localhost bridge (port 38011, token in a discovery file in the temp dir) |

Paths, install, update and upgrade steps are in
[references/setup.md](references/setup.md). Every tool's arguments are in
[references/tools.md](references/tools.md).

## 1. Preflight (first use in a session, or when something looks wrong)

Run the bundled check. It needs only Node 18+ and reports each part with a fix
hint:

```bash
node ~/.claude/skills/eez-studio/scripts/check-setup.mjs
```

If `node` isn't on PATH (fnm/nvm), use the same Node binary the MCP registration
uses — the `command` of `mcpServers["eez-ui"]` in `~/.claude.json`.

Add `--fetch` to also check whether the installed MCP is behind `origin/main`.
If the `mcp__eez-ui__*` tools are missing from the session, the MCP isn't
registered or failed to start; see setup.md before trying anything else.

Live-only tools (`render`, `get_checks`, `build`, `validate`) need EEZ Studio
open. If it is closed, say so and offer to keep authoring in file mode, or ask
the user to open it. Launching it yourself is fine when the user wants live
mode (Windows per-user install:
`Start-Process "$env:LOCALAPPDATA\Programs\eezstudio\EEZ Studio.exe"`); the
bridge is ready about 2 s later, when the discovery file appears.

## 2. The authoring loop

1. **Pick the project.** `open_project(path)` for an existing one, or
   `create_dashboard_project(path, displayWidth?, displayHeight?)` for a new one.
   Use absolute paths with forward slashes (`C:/work/panel.eez-project`); the
   result reports `studioVersion` / `bridgeVersion` and a `warning` if the
   installed bridge is too old — relay that warning, it means live mode is unreliable.
2. **Look before you build** when editing an existing project: `list_pages`,
   `list_widgets(page)`, `list_variables`, `list_connections(page)`. objIDs come
   from here; never guess them.
3. **Check unfamiliar components** with `list_widget_types(kind)` and
   `get_widget_schema(type)` before setting props you haven't used. Unknown
   props come back as a `warning` and are usually a typo or the wrong component.
4. **Build the screen in one `batch` call** (next section) rather than a call per
   widget. Each tool call costs a full model turn while the bridge itself
   answers in a few ms, so a 15-op screen goes from 15 turns to 1, and the user
   gets a single undo step.
5. **Verify**: `get_checks()` → fix every error by objID → `render(page, "design")`
   to see layout and flow wiring → `render(page, "run")` to see the live board →
   `build()` or `validate()` when the user wants it compiled/confirmed.
6. **Save**: live edits stay in memory (the editor shows unsaved changes) until
   `save()`. `build`/`validate` save first. Tell the user when you saved.

## 3. batch

```
batch({ project?, ops: [{ tool, args, as? }, ...] })   // 1–200 ops, run in order
```

- `tool`: `add_page`, `add_widget`, `add_action_component`, `update_widget`,
  `delete_widget`, `add_variable`, `bind_widget`, `add_event_handler`,
  `connect`, `disconnect`. `args` are that tool's arguments **without** `project`
  (extra keys are rejected).
- **Aliases**: `add_widget` / `add_action_component` may set `as: "btn"`
  (letters, digits, `_`). A later op passes `"$btn"` as `objID`, `source` or
  `target` and gets the created objID. Only those three fields are substituted.
  Pages and variables are referenced by name, so they need no alias.
- **All-or-nothing**: everything is validated first; live it is one undo step and
  is rolled back if any op fails; in file mode it is one save. A failure reads
  `batch op #k (tool) failed: …; nothing applied`, so fix op k and resend the
  whole batch.
- Returns `{ via, applied, results:[{index, tool, as?, …}], refs:{alias: objID} }`.
  Keep `refs` — they are the objIDs for follow-up edits.

Example — a counter with an increment button:

```
batch(ops=[
  { tool: "add_page", args: { name: "Main" } },
  { tool: "add_variable", args: { name: "counter", type: "integer", defaultValue: "0" } },
  { tool: "add_widget", as: "value", args: { page: "Main", type: "TextDashboardWidget",
      left: 20, top: 20, width: 220, height: 30, data: "counter" } },
  { tool: "add_widget", as: "inc", args: { page: "Main", type: "ButtonDashboardWidget",
      left: 20, top: 70, width: 160, height: 44, data: "\"Increment\"" } },
  { tool: "add_event_handler", args: { page: "Main", objID: "$inc", eventName: "CLICKED" } },
  { tool: "add_action_component", as: "set", args: { page: "Main",
      type: "SetVariableActionComponent", left: 260, top: 70,
      props: { entries: [{ variable: "counter", value: "counter + 1" }] } } },
  { tool: "connect", args: { page: "Main", source: "$inc", output: "CLICKED",
      target: "$set", input: "@seqin" } }
])
```

Single-op tools still make sense for one small tweak (`update_widget` on one
objID) or when the next step depends on reading something back first.

## 4. Conventions that matter

- **Expressions** (`data`, `bind_widget`, `defaultValue`, action values): a bare
  name is a variable (`counter`), quoted text is a literal (`"\"Hello\""` — the
  quotes are part of the expression), numbers/booleans are literals (`42`,
  `true`), operators work (`counter + 1`).
- **Variable types**: `integer`, `float`, `double`, `boolean`, `string`, `date`,
  `json`, `any`, or `enum:Name` / `struct:Name` / `array:T`.
- **Flow wiring**: a widget needs an event handler (`add_event_handler`,
  `handlerType: "flow"`, e.g. `eventName: "CLICKED"`) before its event pin exists.
  Sequence pins are `@seqout` → `@seqin`; data pins use their names. Chain
  actions with `@seqout` → `@seqin`.
- **Geometry** is in pixels from the page's top-left; leave ~20 px margins and
  keep action components to the right of the widgets so the flow graph stays
  readable in the design render.
- `objID` and `type` can't be changed through props (it would orphan the
  component's connections). To change a type, delete and re-add.
- No `remove_page` / `remove_variable` tools exist yet; tell the user if they ask.

## 5. When a call fails

The error tells you whether the edit happened, which decides what to do next:

| Error says | Meaning | Do |
|------------|---------|----|
| result is `"via":"file"` but you expected live | Bridge not reachable (Studio closed, stale discovery file) | Fine for authoring; open Studio for live/verify tools |
| "editor may have applied it" | Request delivered, reply timed out | **Don't retry blindly.** `list_*` first, then redo only what's missing |
| "bridge HTTP 401 … not applied" | Token rejected | Restart EEZ Studio (or fix `EEZ_BRIDGE_URL`/`EEZ_BRIDGE_TOKEN`), retry |
| "does not support batch" / bridge version `warning` | Installed bridge older than the MCP | Update the bridge (setup.md), restart Studio |
| "editor busy" | The user is mid-edit in Studio | Wait a moment, retry |
| "needs EEZ Studio running" | Live-only tool in file mode | Open Studio or skip verification and say so |

Don't edit the `.eez-project` file by hand while it is open in EEZ Studio: the
editor holds its own copy in memory and the next save overwrites yours. Go
through the MCP, which uses the live editor when it's open.
