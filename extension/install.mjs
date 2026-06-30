#!/usr/bin/env node
// Install the eez-ui-bridge extension into EEZ Studio's user-data extensions
// folder, so a running EEZ Studio exposes the live control bridge for the
// eez-ui MCP. Re-run after editing the extension; restart EEZ Studio to load.
//
//   node install.mjs            # install/update
//   node install.mjs --uninstall
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = "eezstudio"; // electron app name (package.json "name")
const FILES = ["index.js", "live-ops.js", "package.json", "README.md"];

// Mirror Electron's app.getPath("userData") = appData/<name> per platform.
function userDataDir() {
    if (process.platform === "win32") {
        return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP);
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", APP);
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), APP);
}

const dest = path.join(userDataDir(), "extensions", "eez-ui-bridge");

if (process.argv.includes("--uninstall")) {
    fs.rmSync(dest, { recursive: true, force: true });
    console.log("Removed", dest);
    console.log("Restart EEZ Studio to unload the extension.");
    process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
for (const f of FILES) {
    const src = path.join(here, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
}
console.log("Installed eez-ui-bridge ->", dest);
console.log("Restart EEZ Studio, then run any eez-ui MCP tool; results tagged");
console.log('  "via":"live-editor" confirm the live bridge is active.');
