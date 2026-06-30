#!/usr/bin/env node
// Build a distributable zip of the eez-ui-bridge extension:
//   dist/eez-ui-bridge-<version>.zip   containing a top-level eez-ui-bridge/ folder.
// Install on any machine by unzipping into EEZ Studio's user-data extensions/
// directory (see README), or with install.mjs.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const FILES = ["index.js", "live-ops.js", "package.json", "README.md", "install.mjs"];

const dist = path.join(here, "dist");
const stage = path.join(dist, "eez-ui-bridge");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(here, f), path.join(stage, f));

const zipPath = path.join(dist, `eez-ui-bridge-${pkg.version}.zip`);
if (process.platform === "win32") {
    // Compress-Archive on the staged folder -> top-level eez-ui-bridge/ in the zip.
    execFileSync(
        "powershell",
        [
            "-NoProfile",
            "-Command",
            `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -Force`
        ],
        { stdio: "inherit" }
    );
} else {
    execFileSync("zip", ["-r", zipPath, "eez-ui-bridge"], {
        cwd: dist,
        stdio: "inherit"
    });
}
console.log("Built", zipPath);
