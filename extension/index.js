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

// Max request body size; a runaway client gets a 413 instead of exhausting memory.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// Both the extension (renderer) and the external MCP compute this same path.
const DISCOVERY_FILE = path.join(os.tmpdir(), "eez-ui-bridge.json");

// Capabilities the MCP can probe for (via /ping or the discovery file).
const FEATURES = ["batch"];

// The bridge's own version comes from the extension package.json (single source
// of truth); the MCP compares it against the version it requires.
const BRIDGE_VERSION = (() => {
    try {
        return JSON.parse(
            fs.readFileSync(path.join(__dirname, "package.json"), "utf8")
        ).version;
    } catch (e) {
        return null;
    }
})();

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

// EEZ Studio app version (e.g. "0.29.0"), or null if it can't be resolved.
// Looked up once (success or failure); /ping is hit often.
let studioVersionCache;

function studioVersion() {
    if (studioVersionCache !== undefined) return studioVersionCache;
    try {
        studioVersionCache = require("./live-ops").getRemote().app.getVersion() || null;
    } catch (e) {
        studioVersionCache = null;
    }
    return studioVersionCache;
}

// --- server ----------------------------------------------------------------

let server = null;
let token = null;
let unloadHooked = false;

function startServer() {
    if (server) return;

    token = crypto.randomBytes(24).toString("hex");
    hookUnload();

    server = http.createServer((req, res) => {
        // Collect raw bytes and decode once at the end: concatenating chunks as
        // strings corrupts multibyte UTF-8 characters split across chunks.
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on("data", chunk => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                // Stop buffering but keep reading (discarding) so the client can
                // finish sending and then read the single 413 instead of EPIPE.
                tooLarge = true;
                chunks.length = 0;
                req.resume();
                send(res, 413, { ok: false, error: "request body too large" });
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (tooLarge) return;
            try {
                handle(req, res, Buffer.concat(chunks).toString("utf8"));
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
    removeDiscovery();
}

// Remove the discovery file, but only if it is ours (same pid + token): another
// Studio window/instance may have overwritten it since. Idempotent and
// exception-safe, so it can run from both destroy() and the window unload hooks.
function removeDiscovery() {
    try {
        const disc = readDiscovery();
        if (disc && disc.pid === process.pid && token && disc.token === token) {
            fs.rmSync(DISCOVERY_FILE, { force: true });
        }
    } catch (e) {
        /* ignore */
    }
}

// destroy() is not called when the user simply quits Studio, which would leave a
// stale discovery file behind; clean up when the renderer window goes away.
// `unload`/`pagehide` (not `beforeunload`, which can be cancelled).
function hookUnload() {
    if (unloadHooked) return;
    try {
        if (typeof window !== "undefined" && window.addEventListener) {
            window.addEventListener("unload", removeDiscovery);
            window.addEventListener("pagehide", removeDiscovery);
            unloadHooked = true;
        }
    } catch (e) {
        /* ignore */
    }
}

function writeDiscovery() {
    try {
        // `mode` is applied on file creation and only honoured on POSIX; on
        // Windows it is ignored (the file inherits the temp dir's ACL).
        fs.writeFileSync(
            DISCOVERY_FILE,
            JSON.stringify({
                port: DEFAULT_PORT,
                token: token,
                pid: process.pid,
                bridgeVersion: BRIDGE_VERSION,
                studioVersion: studioVersion(),
                features: FEATURES,
                ts: Date.now()
            }),
            { mode: 0o600 }
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
            version: BRIDGE_VERSION,
            bridgeVersion: BRIDGE_VERSION,
            studioVersion: studioVersion(),
            features: FEATURES
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
