#!/usr/bin/env node
// Preflight for the eez-ui MCP + eez-ui-bridge + EEZ Studio. No dependencies.
//
//   node check-setup.mjs [--fetch] [--mcp-dir <path>]
//
// --fetch     also `git fetch` the installed MCP clone and report if it is behind origin/main
// --mcp-dir   installed MCP clone (default: the dir of the user-scope "eez-ui" registration,
//             else ~/mcp-servers/eez-ui-mcp; env EEZ_UI_MCP_DIR also works)
//
// Prints one line per check (OK / WARN / FAIL + fix hint). Exit code 1 if any FAIL.
// Never prints the bridge token.
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execFileSync } from "child_process";

const args = process.argv.slice(2);
const FETCH = args.includes("--fetch");
const argDir = args.includes("--mcp-dir") ? args[args.indexOf("--mcp-dir") + 1] : null;

let failed = false;
const line = (status, what, detail = "", fix = "") => {
    if (status === "FAIL") failed = true;
    console.log(`${status.padEnd(4)}  ${what}${detail ? ` — ${detail}` : ""}`);
    if (fix && status !== "OK") console.log(`      fix: ${fix}`);
};
const readJson = p => {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
};
const sameText = (a, b) => {
    try {
        const n = p => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
        return n(a) === n(b);
    } catch {
        return false;
    }
};
const git = (dir, ...a) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// 1. Node
const major = parseInt(process.versions.node.split(".")[0], 10);
line(major >= 18 ? "OK" : "FAIL", "Node", process.version, "install Node 18+ (fnm install --lts)");

// 2. Claude Code registration (user scope)
const claudeJson = readJson(path.join(os.homedir(), ".claude.json"));
const reg = claudeJson && claudeJson.mcpServers && claudeJson.mcpServers["eez-ui"];
let regServer = null;
if (reg) {
    regServer = (reg.args || []).find(a => /server\.js$/i.test(a)) || null;
    const cmdOk = reg.command && (fs.existsSync(reg.command) || !/[\\/]/.test(reg.command));
    const srvOk = regServer && fs.existsSync(regServer);
    line(
        cmdOk && srvOk ? "OK" : "FAIL",
        "MCP registration (user scope)",
        `${reg.command} ${regServer || "(no server.js arg)"}`,
        "re-register: see references/setup.md → Fresh install"
    );
} else {
    line("WARN", "MCP registration (user scope)", "no user-scope eez-ui entry",
        "claude mcp add --scope user eez-ui -- <node.exe> <clone>/mcp/server.js (references/setup.md)");
}

// 3. Installed MCP clone
const mcpDir =
    argDir ||
    process.env.EEZ_UI_MCP_DIR ||
    (regServer ? path.dirname(path.dirname(regServer)) : path.join(os.homedir(), "mcp-servers", "eez-ui-mcp"));
const mcpPkg = readJson(path.join(mcpDir, "mcp", "package.json"));
if (!mcpPkg) {
    line("FAIL", "Installed MCP", `not found at ${mcpDir}`, "git clone https://github.com/azevedonik/eez-ui-mcp.git " + mcpDir);
} else {
    line("OK", "Installed MCP", `v${mcpPkg.version} at ${mcpDir}`);
    const nm = ["@modelcontextprotocol/sdk", "zod"].every(d =>
        fs.existsSync(path.join(mcpDir, "mcp", "node_modules", d, "package.json"))
    );
    line(nm ? "OK" : "FAIL", "MCP dependencies", nm ? "node_modules present" : "missing", `cd "${path.join(mcpDir, "mcp")}" && pnpm install`);
    try {
        const head = git(mcpDir, "rev-parse", "--short", "HEAD");
        const branch = git(mcpDir, "rev-parse", "--abbrev-ref", "HEAD");
        if (FETCH) git(mcpDir, "fetch", "-q", "origin");
        const behind = parseInt(git(mcpDir, "rev-list", "--count", "HEAD..origin/main"), 10);
        line(
            behind ? "WARN" : "OK",
            "MCP git state",
            `${branch}@${head}${behind ? `, ${behind} commit(s) behind origin/main` : FETCH ? ", up to date" : " (run with --fetch to compare with GitHub)"}`,
            `git -C "${mcpDir}" pull --ff-only, then node extension/install.mjs`
        );
    } catch {
        line("WARN", "MCP git state", "not a git checkout (can't tell if it is current)");
    }
}

// 4. Bridge extension installed in EEZ Studio
const userData =
    process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "eezstudio")
        : process.platform === "darwin"
          ? path.join(os.homedir(), "Library", "Application Support", "eezstudio")
          : path.join(os.homedir(), ".config", "eezstudio");
const extDir = path.join(userData, "extensions", "eez-ui-bridge");
const extPkg = readJson(path.join(extDir, "package.json"));
const repoExt = path.join(mcpDir, "extension");
const repoExtPkg = readJson(path.join(repoExt, "package.json"));
if (!extPkg) {
    line("FAIL", "Bridge extension", `not installed in ${extDir}`, `node "${path.join(repoExt, "install.mjs")}", then restart EEZ Studio`);
} else {
    const same = ["index.js", "live-ops.js", "package.json"].every(f => sameText(path.join(extDir, f), path.join(repoExt, f)));
    line(
        same ? "OK" : "WARN",
        "Bridge extension",
        `v${extPkg.version}${repoExtPkg ? ` (repo v${repoExtPkg.version})` : ""}${same ? ", matches installed MCP" : ", differs from the installed MCP's extension/"}`,
        `node "${path.join(repoExt, "install.mjs")}", then restart EEZ Studio`
    );
}

// 5. EEZ Studio install
if (process.platform === "win32") {
    const exe = path.join(process.env.LOCALAPPDATA || "", "Programs", "eezstudio", "EEZ Studio.exe");
    let ver = null;
    try {
        const out = execFileSync(
            "reg",
            ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "EEZ Studio"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
        );
        // /f only lists values containing the search text, so read the version
        // from DisplayName ("EEZ Studio 0.29.0").
        const m = out.match(/DisplayName\s+REG_SZ\s+EEZ Studio\s+(\d+\.\d+\.\d+\S*)/);
        ver = m && m[1];
    } catch {
        /* not found */
    }
    line(
        fs.existsSync(exe) ? "OK" : "FAIL",
        "EEZ Studio",
        fs.existsSync(exe) ? `${ver ? "v" + ver : "version unknown"} at ${exe}` : "not found",
        "install from https://github.com/eez-open/studio/releases (references/setup.md → Upgrading)"
    );
}

// 6. Live bridge (only if Studio is running)
const discPath = process.env.EEZ_BRIDGE_DISCOVERY || path.join(os.tmpdir(), "eez-ui-bridge.json");
const disc = readJson(discPath);
const alive = pid => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code !== "ESRCH";
    }
};
if (!disc) {
    line("WARN", "Live bridge", "EEZ Studio not running (no discovery file): authoring works in file mode, render/get_checks/build/validate need Studio open");
} else if (Number.isInteger(disc.pid) && !alive(disc.pid)) {
    line("WARN", "Live bridge", "stale discovery file (Studio exited without cleanup); harmless, ignored by the MCP");
} else {
    const info = await new Promise(resolve => {
        const req = http.get({ host: "127.0.0.1", port: disc.port, path: "/ping", timeout: 1500, agent: false }, res => {
            let d = "";
            res.setEncoding("utf8");
            res.on("data", c => (d += c));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(d));
                } catch {
                    resolve(null);
                }
            });
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(null));
    });
    if (!info || !info.ok) {
        line("FAIL", "Live bridge", `discovery file present but port ${disc.port} does not answer /ping`, "restart EEZ Studio; check nothing else uses the port");
    } else {
        const bv = info.bridgeVersion || info.version;
        const match = !repoExtPkg || bv === repoExtPkg.version;
        line(
            match ? "OK" : "WARN",
            "Live bridge",
            `EEZ Studio ${info.studioVersion || "?"}, bridge ${bv} on port ${disc.port}${match ? "" : ` (installed MCP expects ${repoExtPkg.version}: restart Studio after install.mjs)`}`
        );
    }
}

console.log(failed ? "\nSetup has problems (see FAIL lines)." : "\nSetup OK.");
process.exit(failed ? 1 : 0);
