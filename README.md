# eez-ui-mcp

Author EEZ Studio **Dashboard** UI from Claude Code — **live, in the running
editor**. Ask Claude to build a screen and the widgets, variables, data
bindings, and flow connections appear in your EEZ Studio window in real time
(vibe-coding), with full undo. Claude can also read the editor's **Checks**
diagnostics and render the page to verify its work.

Two parts, plus a Claude Code skill:

| Folder | What it is |
|--------|------------|
| [`extension/`](extension) | **`eez-ui-bridge`** — an EEZ Studio *project-editor extension* (plugin) that hosts a localhost control bridge inside the running app. Plain JS, zero dependencies. |
| [`mcp/`](mcp) | **`eez-ui`** — the [MCP](https://modelcontextprotocol.io) server Claude Code talks to. It drives the editor through the bridge (and edits `.eez-project` JSON directly as a no-app fallback for authoring). |
| [`skills/eez-studio/`](skills/eez-studio) | **`eez-studio`** — a Claude Code skill that teaches Claude the authoring loop (batch, checks, render), the tool reference, setup/update steps, and a preflight script. Optional but recommended. |

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

1. **Install the plugin** into EEZ Studio (any 0.28.x–0.29.x install):
   ```
   node extension/install.mjs        # then restart EEZ Studio
   ```
   (Or unzip `extension/dist/eez-ui-bridge-*.zip` into EEZ Studio's user-data
   `extensions/` folder — see [extension/README.md](extension/README.md).)

2. **Register the MCP** with Claude Code — point it at `mcp/server.js` (see
   [mcp/README.md](mcp/README.md)). A ready-to-use [`.mcp.json`](.mcp.json) is
   included for running Claude Code from this repo.

3. **Install the skill** (optional, recommended) — see
   [Claude Code skill](#claude-code-skill) below.

4. **Open a Dashboard project** in EEZ Studio and ask Claude to build UI.

## Claude Code skill

[`skills/eez-studio/`](skills/eez-studio) packages how to use this MCP well:
when to use `batch`, the expression/flow-pin conventions, how to verify with
`get_checks` and `render`, what each error class means, and how to install,
update and troubleshoot the MCP, the bridge and EEZ Studio. Claude loads it
automatically when you mention EEZ Studio, an `.eez-project`, EEZ Flow, etc.

| File | Contents |
|------|----------|
| `SKILL.md` | Authoring loop, `batch`, conventions, error handling |
| `references/tools.md` | Every tool's arguments and results, component catalog |
| `references/setup.md` | Install, update, EEZ Studio upgrade, dev workflow, troubleshooting |
| `scripts/check-setup.mjs` | Preflight: Node, MCP registration, installed clone (`--fetch`: behind `origin/main`?), bridge version, EEZ Studio, live bridge |

Install it for your user (all projects) by copying the folder into
`~/.claude/skills/`:

```bash
# macOS / Linux / Git Bash
mkdir -p ~/.claude/skills && cp -r skills/eez-studio ~/.claude/skills/
```

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse -Force skills\eez-studio "$HOME\.claude\skills\"
```

(For a single project only, copy it into that project's `.claude/skills/`
instead.) Start a new Claude Code session, then check everything is ready:

```bash
node ~/.claude/skills/eez-studio/scripts/check-setup.mjs --fetch
```

To update the skill later, pull this repo and copy the folder again.

## Requirements

- **EEZ Studio 0.28.x–0.29.x (tested on 0.29.0)** installed (the plugin runs inside it).
- **Node 18+** to run the MCP server.

No build of EEZ Studio is needed. Authoring tools work without the app too (they
edit the `.eez-project` JSON); `render` / `build` / `validate` / `get_checks`
require the app to be open with the plugin.

## License

GPL-3.0-only. The plugin loads EEZ Studio's modules at runtime, so it is a
derivative work of EEZ Studio (GPL-3.0); this whole repository is distributed
under the same license. See [LICENSE](LICENSE).
