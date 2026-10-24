# Setup, update and troubleshooting

## Contents
- Layout
- Fresh install / re-register
- Updating the MCP and the bridge
- Upgrading EEZ Studio
- Working on the MCP itself
- Troubleshooting

## Layout

| What | Where (defaults) |
|------|------------------|
| Installed MCP (what Claude Code runs) | A git clone of `github.com/azevedonik/eez-ui-mcp` on `main`, with `mcp/node_modules` installed. Convention: `~/mcp-servers/eez-ui-mcp`. Keep it separate from any dev checkout so work-in-progress doesn't break the MCP you use every day. |
| MCP registration | user scope in `~/.claude.json` → `mcpServers["eez-ui"]` (`command` = Node binary, `args` = `<clone>/mcp/server.js`) |
| Bridge extension | EEZ Studio user data `extensions/eez-ui-bridge/`: Windows `%APPDATA%\eezstudio\extensions\`, macOS `~/Library/Application Support/eezstudio/extensions/`, Linux `~/.config/eezstudio/extensions/` |
| EEZ Studio (Windows per-user install) | `%LOCALAPPDATA%\Programs\eezstudio\EEZ Studio.exe` |
| Bridge discovery file | `<os temp dir>/eez-ui-bridge.json` (port, token, pid, versions) — written when Studio starts, removed when it exits |

Node: the MCP needs Node 18+. If Node is managed by fnm/nvm it is often not on
PATH for Claude Code, so register the MCP with the absolute Node path (fnm on
Windows: `%APPDATA%\fnm\aliases\default\node.exe`; nvm/fnm on macOS/Linux:
`$(which node)` inside a shell where it is active).

## Fresh install / re-register

```bash
git clone https://github.com/azevedonik/eez-ui-mcp.git ~/mcp-servers/eez-ui-mcp
cd ~/mcp-servers/eez-ui-mcp/mcp && npm install     # or pnpm install
cd .. && node extension/install.mjs                # bridge into EEZ Studio's extensions folder
claude mcp add --scope user eez-ui -- "<absolute path to node>" "<home>/mcp-servers/eez-ui-mcp/mcp/server.js"
```

Then restart EEZ Studio (the bridge loads at startup) and restart Claude Code
(or reconnect the MCP from `/mcp`) so the new server process starts.

If you also run Claude Code inside a dev checkout of the repo, its `.mcp.json`
adds a project-scoped `eez-ui` and `claude mcp list` warns that the server is
defined in two scopes. Inside the repo the project entry wins, which is usually
what you want while developing; otherwise remove one with
`claude mcp remove eez-ui -s project`.

## Updating the MCP and the bridge

The MCP and bridge ship together; update both, then restart both sides:

```bash
cd ~/mcp-servers/eez-ui-mcp && git pull --ff-only
cd mcp && npm install                     # only needed if package.json changed
cd .. && node extension/install.mjs      # copies extension/ into Studio's extensions folder
```

Restart EEZ Studio, then reconnect the MCP in Claude Code. Run the preflight
(`scripts/check-setup.mjs --fetch`) to confirm: clone up to date, bridge version
= repo extension version, and `studioVersion` reported once Studio is open.

To update this skill too, copy the repo's `skills/eez-studio/` over
`~/.claude/skills/eez-studio/`.

## Upgrading EEZ Studio

```bash
gh release list -R eez-open/studio -L 3
gh release download vX.Y.Z -R eez-open/studio -p "EEZ-Studio-Setup-X.Y.Z.exe" -p latest.yml -D <empty scratch dir>
# verify: base64(sha512(installer)) must equal the sha512 in latest.yml
openssl dgst -sha512 -binary EEZ-Studio-Setup-X.Y.Z.exe | base64 -w0
```

On Windows, close EEZ Studio, then install per-user and silently:
`Start-Process <installer> -ArgumentList '/S','/currentuser' -Wait`.
Afterwards run the repo's live smoke test (below) before trusting live mode on
the new version, and read the release's changes to `packages/project-editor`
(store, flow, features/page, extension loading) — the bridge requires those
internal modules directly. Update the "tested on" line in the READMEs/CHANGELOG.

## Working on the MCP itself (dev checkout)

```bash
cd <dev checkout>/mcp
npm test               # unit tests, no app needed (node:test)
npm run test:mcp       # stdio smoke test; live steps need EEZ Studio open with the bridge
```

The smoke test creates its own project in `<temp>/eez-mcp-server-test/`. After
changing `extension/`, run `node extension/install.mjs` and restart Studio before
the live test. The repo tracks `package-lock.json`; if you use pnpm, don't
commit the `pnpm-lock.yaml` it creates. Ship changes by merging to `main`, then
update the installed clone as above.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| No `mcp__eez-ui__*` tools in the session | MCP not registered or crashed at start. `claude mcp list`; run the registered command by hand to see the error (often missing `node_modules` → `npm install`, or `node` not found → use an absolute Node path). |
| Everything returns `"via":"file"` with Studio open | Bridge not loaded: check `extensions/eez-ui-bridge/index.js` exists, restart Studio, check the discovery file appears. Another process on port 38011 also blocks it (`EEZ_BRIDGE_PORT` in Studio's environment changes the port). |
| `warning: eez-ui-bridge … is older than …` | Re-run `node extension/install.mjs` from the installed clone, restart Studio. |
| HTTP 401 | Token mismatch: restart Studio; unset stale `EEZ_BRIDGE_URL`/`EEZ_BRIDGE_TOKEN`. |
| Studio won't close after tests | It may be showing a save prompt for a modified project; confirm or discard in the window. |
