// HTTP client for the eez-ui-bridge extension running inside a live EEZ Studio.
//
// When EEZ Studio is open with the bridge extension installed, the editor hosts
// a localhost control server and writes a discovery file (port + per-session
// token) to the OS temp dir. This client reads that file and POSTs operations to
// /op so the MCP can drive the *running* editor (live, visible edits).
//
// Errors are classified so the backend can decide whether to fall back to the
// headless CLI path:
//   - a "transport" error (no discovery file, connection refused, timeout, non-200)
//     means the bridge isn't usable right now  -> caller may fall back.
//   - an "opError" (HTTP 200 with { ok:false }) is a real, user-facing failure
//     from the editor (bad page/objID, unknown type, ...) -> do NOT fall back.
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";

// Must match DISCOVERY_FILE in eez-ui-bridge/index.js.
export const DISCOVERY_FILE =
    process.env.EEZ_BRIDGE_DISCOVERY ||
    path.join(os.tmpdir(), "eez-ui-bridge.json");

export function transportError(message) {
    const e = new Error(message);
    e.transport = true;
    return e;
}

export function readDiscovery() {
    // Allow a fully manual override (host:port + token) via env.
    if (process.env.EEZ_BRIDGE_URL && process.env.EEZ_BRIDGE_TOKEN) {
        try {
            const u = new URL(process.env.EEZ_BRIDGE_URL);
            return {
                port: Number(u.port) || 38011,
                host: u.hostname || "127.0.0.1",
                token: process.env.EEZ_BRIDGE_TOKEN
            };
        } catch {
            /* fall through to discovery file */
        }
    }
    try {
        const d = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
        if (d && d.port && d.token) return d;
    } catch {
        /* not running */
    }
    return null;
}

function httpJson(disc, method, pathname, bodyObj, timeoutMs) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
        const req = http.request(
            {
                host: disc.host || "127.0.0.1",
                port: disc.port,
                path: pathname,
                method,
                headers: {
                    "Content-Type": "application/json",
                    "x-eez-bridge-token": disc.token,
                    ...(payload ? { "Content-Length": payload.length } : {})
                },
                timeout: timeoutMs
            },
            res => {
                let data = "";
                res.on("data", d => (data += d));
                res.on("end", () => {
                    let json = null;
                    try {
                        json = data ? JSON.parse(data) : null;
                    } catch (e) {
                        return reject(transportError("bad bridge response"));
                    }
                    resolve({ status: res.statusCode, json });
                });
            }
        );
        req.on("error", e => reject(transportError(String(e.message || e))));
        req.on("timeout", () => {
            req.destroy();
            reject(transportError("bridge request timed out"));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

// Quick reachability check. Returns the discovery record if the bridge answers
// /ping, else null. Never throws.
export async function ping(timeoutMs = 800) {
    const disc = readDiscovery();
    if (!disc) return null;
    try {
        const r = await httpJson(disc, "GET", "/ping", null, timeoutMs);
        return r.status === 200 && r.json && r.json.ok ? disc : null;
    } catch {
        return null;
    }
}

// Invoke an editor operation. Resolves to the op's `result`; throws a transport
// error (caller may fall back) or an opError (caller should surface it).
export async function op(name, args = {}, timeoutMs = 60000) {
    const disc = readDiscovery();
    if (!disc) throw transportError("bridge not running (no discovery file)");
    const r = await httpJson(
        disc,
        "POST",
        "/op",
        { op: name, ...args },
        timeoutMs
    );
    if (r.status !== 200) throw transportError("bridge HTTP " + r.status);
    if (!r.json) throw transportError("empty bridge response");
    if (!r.json.ok) {
        const e = new Error(r.json.error || "bridge op failed");
        e.opError = true;
        throw e;
    }
    return r.json.result;
}
