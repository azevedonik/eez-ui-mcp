// eez-ui-bridge — an EEZ Studio project-editor extension (pext) that hosts a
// localhost control server so the external `eez-ui` MCP can drive the *running*
// editor live (vibe-coding): add widgets/variables, bind expressions, wire flow
// connections, render and save — and the user watches it happen in their window.
//
// Why this works (no app source changes needed):
//   - EEZ Studio loads extensions via `require(folder).default` and calls init().
//     The app registers `build/` as a global Node module root (app-module-path),
//     so from here `require("home/tabs-store")` / `require("project-editor/store")`
//     resolve to the SAME live singletons the app uses (shared require cache).
//   - The renderer runs with nodeIntegration, so we can host an http server here
//     (same pattern the LVGL docker preview-server uses).
//
// SECURITY: the server binds to 127.0.0.1 only and requires a per-session token
// for every request except /ping. The token is written to a discovery file the
// MCP reads. The bridge can drive the editor, so treat the token as sensitive.
//
// This file is plain CommonJS with ZERO npm dependencies (Node built-ins + the
// app's own modules resolved at runtime) so the extension needs no build step.

"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_PORT = parseInt(process.env.EEZ_BRIDGE_PORT || "38011", 10);

// Both the extension (renderer) and the external MCP compute this same path.
const DISCOVERY_FILE = path.join(os.tmpdir(), "eez-ui-bridge.json");

function log(...args) {
    try {
        // eslint-disable-next-line no-console
        console.log("[eez-ui-bridge]", ...args);
    } catch (e) {
        /* ignore */
    }
}

// --- live app access -------------------------------------------------------
// Resolved lazily (not at module load) so requiring this file in the main
// process — which also loads extensions — never touches renderer-only modules.

function getTabs() {
    // "home/tabs-store" resolves to build/home/tabs-store.js via app-module-path.
    return require("home/tabs-store").tabs;
}

function activeProjectInfo() {
    const tabs = getTabs();
    const tab = tabs && tabs.activeTab;
    const store = tab && tab.projectStore;
    const general =
        store &&
        store.project &&
        store.project.settings &&
        store.project.settings.general;
    return {
        hasTabs: !!tabs,
        activeTabType: tab && tab.constructor ? tab.constructor.name : null,
        projectFilePath: store ? store.filePath || null : null,
        projectType: general ? general.projectType : null,
        pagesCount:
            store && store.project && store.project.pages
                ? store.project.pages.length
                : null
    };
}

// --- server ----------------------------------------------------------------

let server = null;
let token = null;

function startServer() {
    if (server) return;

    token = crypto.randomBytes(24).toString("hex");

    server = http.createServer((req, res) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 16 * 1024 * 1024) req.destroy(); // 16 MB cap
        });
        req.on("end", () => {
            try {
                handle(req, res, body);
            } catch (e) {
                send(res, 500, { ok: false, error: errString(e) });
            }
        });
    });

    server.on("error", err => {
        if (err && err.code === "EADDRINUSE") {
            // Another renderer (or a stale instance) already owns the port.
            log("port " + DEFAULT_PORT + " in use; not starting a second bridge");
            server = null;
            return;
        }
        log("server error", err && err.message);
    });

    server.listen(DEFAULT_PORT, "127.0.0.1", () => {
        writeDiscovery();
        log("listening on 127.0.0.1:" + DEFAULT_PORT);
    });
}

function stopServer() {
    if (server) {
        try {
            server.close();
        } catch (e) {
            /* ignore */
        }
        server = null;
    }
    try {
        const disc = readDiscovery();
        if (disc && disc.pid === process.pid) fs.rmSync(DISCOVERY_FILE, { force: true });
    } catch (e) {
        /* ignore */
    }
}

function writeDiscovery() {
    try {
        fs.writeFileSync(
            DISCOVERY_FILE,
            JSON.stringify({
                port: DEFAULT_PORT,
                token: token,
                pid: process.pid,
                ts: Date.now()
            })
        );
    } catch (e) {
        log("discovery write failed", e && e.message);
    }
}

function readDiscovery() {
    try {
        return JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

function send(res, code, obj) {
    const s = JSON.stringify(obj);
    res.writeHead(code, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(s)
    });
    res.end(s);
}

function errString(e) {
    return String((e && (e.stack || e.message)) || e);
}

function authorized(req) {
    const header = req.headers["x-eez-bridge-token"];
    return token && header === token;
}

function handle(req, res, body) {
    const url = (req.url || "").split("?")[0];

    // Health check — no auth, no app access. Proves the server is up.
    if (url === "/ping") {
        return send(res, 200, {
            ok: true,
            processType: typeof process !== "undefined" ? process.type : null,
            version: "0.1.0"
        });
    }

    if (!authorized(req)) {
        return send(res, 401, { ok: false, error: "missing or bad token" });
    }

    // Quick health/diagnostic: proves require-into-the-live-bundle + tabs.
    if (url === "/status") {
        let info = null;
        let error = null;
        try {
            info = activeProjectInfo();
        } catch (e) {
            error = errString(e);
        }
        return send(res, 200, { ok: !error, info: info, error: error });
    }

    // Main entry: { op, ...args } -> drive the live editor. Async.
    if (url === "/op" && req.method === "POST") {
        let request;
        try {
            request = JSON.parse(body || "{}");
        } catch (e) {
            return send(res, 400, { ok: false, error: "invalid JSON body" });
        }
        const { dispatch } = require("./live-ops");
        Promise.resolve()
            .then(() => dispatch(request.op, request))
            .then(result => send(res, 200, { ok: true, result: result }))
            .catch(e => send(res, 200, { ok: false, error: errString(e) }));
        return;
    }

    return send(res, 404, { ok: false, error: "unknown endpoint: " + url });
}

// --- extension definition --------------------------------------------------

const extension = {
    init() {
        // Extensions load in BOTH the main and renderer processes; the live
        // editor state (tabs / projectStore) only exists in the renderer, so
        // only host the bridge there.
        if (typeof process === "undefined" || process.type !== "renderer") {
            return;
        }
        try {
            startServer();
        } catch (e) {
            log("init failed", errString(e));
        }
    },

    destroy() {
        stopServer();
    }
};

module.exports.default = extension;
