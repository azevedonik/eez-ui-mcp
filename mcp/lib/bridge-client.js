// HTTP client for the eez-ui-bridge extension running inside a live EEZ Studio.
//
// When EEZ Studio is open with the bridge extension installed, the editor hosts
// a localhost control server and writes a discovery file (port + per-session
// token + pid) to the OS temp dir. This client reads that file and POSTs
// operations to /op so the MCP can drive the *running* editor (live, visible
// edits).
//
// Errors are classified so the backend can decide whether falling back to the
// file path is SAFE (i.e. the editor certainly did not apply the edit):
//   - notDelivered: no discovery file, discovery pid is dead, connection
//     refused, or connect timeout. The request never reached the editor
//     -> caller may fall back to the file path.
//   - ambiguous: the request was sent but the reply timed out / the socket was
//     reset / the reply was unreadable. The editor MAY have applied it
//     -> caller must NOT fall back (that would apply the edit twice).
//   - httpStatus: the bridge answered with a non-200 (401 bad token, 404, ...).
//     Nothing was applied, but the bridge is up, so the project is likely open
//     in the editor -> do NOT fall back (editing the file under it is unsafe).
//   - opError: HTTP 200 with { ok:false } is a real, user-facing failure from
//     the editor (bad page/objID, unknown type, ...) -> surface it.
// All but opError also carry `transport: true`.
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";

// Must match DISCOVERY_FILE in eez-ui-bridge/index.js.
export const DISCOVERY_FILE =
    process.env.EEZ_BRIDGE_DISCOVERY ||
    path.join(os.tmpdir(), "eez-ui-bridge.json");

// Upper bound for establishing the TCP connection. Localhost either accepts
// at once or refuses (Windows retries the SYN for ~2 s before refusing).
const CONNECT_TIMEOUT_MS = 5000;

export function transportError(message, extra = {}) {
    const e = new Error(message);
    e.transport = true;
    Object.assign(e, extra);
    return e;
}

function notDeliveredError(message) {
    return transportError(message, { notDelivered: true });
}

function ambiguousError(reason) {
    return transportError(
        `bridge ${reason} after the request was sent: the editor may have applied it. ` +
            "Not retried via the file path; check with list_pages / list_widgets / " +
            "list_variables / list_connections before retrying.",
        { ambiguous: true }
    );
}

function httpStatusError(status, bridgeMessage) {
    let msg = `bridge HTTP ${status}${bridgeMessage ? ` (${bridgeMessage})` : ""}; not applied.`;
    if (status === 401) {
        msg +=
            " The bridge rejected the token: restart EEZ Studio, or fix " +
            "EEZ_BRIDGE_URL/EEZ_BRIDGE_TOKEN if set.";
    }
    return transportError(msg, { httpStatus: status });
}

// Is `pid` a running process? Only a definite ESRCH counts as dead; EPERM
// (exists, not ours) and anything unexpected count as alive.
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return !(e && e.code === "ESRCH");
    }
}

export function readDiscovery() {
    // Allow a fully manual override (host:port + token) via env. No pid, so no
    // liveness check.
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
    let d;
    try {
        d = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
    } catch {
        return null; /* not running */
    }
    if (!d || !d.port || !d.token) return null;
    // Stale file left by an EEZ Studio that exited without cleaning up: skip
    // the network entirely. (Older bridges write no pid -> treat as alive.)
    if (Number.isInteger(d.pid) && d.pid > 0 && !pidAlive(d.pid)) return null;
    return d;
}

function httpJson(disc, method, pathname, bodyObj, timeoutMs) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
        let connected = false;
        let settled = false;
        const done = (fn, v) => {
            if (settled) return;
            settled = true;
            clearTimeout(connectTimer);
            fn(v);
        };
        const req = http.request(
            {
                host: disc.host || "127.0.0.1",
                port: disc.port,
                path: pathname,
                method,
                agent: false, // fresh socket per request: "connected" is exact
                headers: {
                    "Content-Type": "application/json",
                    "x-eez-bridge-token": disc.token,
                    ...(payload ? { "Content-Length": payload.length } : {})
                },
                timeout: timeoutMs
            },
            res => {
                res.setEncoding("utf8"); // decodes multibyte chars split across chunks
                let data = "";
                res.on("data", d => (data += d));
                res.on("error", () => done(reject, ambiguousError("reply was cut off")));
                res.on("aborted", () => done(reject, ambiguousError("reply was cut off")));
                res.on("end", () => {
                    let json = null;
                    try {
                        json = data ? JSON.parse(data) : null;
                    } catch (e) {
                        if (res.statusCode !== 200) {
                            return done(reject, httpStatusError(res.statusCode));
                        }
                        return done(reject, ambiguousError("reply was not valid JSON"));
                    }
                    done(resolve, { status: res.statusCode, json });
                });
            }
        );
        const connectTimer = setTimeout(() => {
            if (connected) return;
            req.destroy();
            done(reject, notDeliveredError("bridge connect timed out"));
        }, Math.min(timeoutMs, CONNECT_TIMEOUT_MS));
        req.on("socket", s => {
            if (!s.connecting) connected = true;
            else s.once("connect", () => (connected = true));
        });
        req.on("error", e => {
            const msg = String((e && e.message) || e);
            done(
                reject,
                connected
                    ? ambiguousError(`connection failed (${msg})`)
                    : notDeliveredError(`bridge not reachable (${msg})`)
            );
        });
        req.on("timeout", () => {
            const err = connected
                ? ambiguousError(`request timed out after ${timeoutMs} ms`)
                : notDeliveredError("bridge connect timed out");
            req.destroy();
            done(reject, err);
        });
        if (payload) req.write(payload);
        req.end();
    });
}

async function pingDisc(timeoutMs) {
    const disc = readDiscovery();
    if (!disc) return null;
    try {
        const r = await httpJson(disc, "GET", "/ping", null, timeoutMs);
        return r.status === 200 && r.json && r.json.ok ? { disc, info: r.json } : null;
    } catch {
        return null;
    }
}

// Quick reachability check. Returns the discovery record if the bridge answers
// /ping, else null. Never throws.
export async function ping(timeoutMs = 800) {
    const r = await pingDisc(timeoutMs);
    return r && r.disc;
}

// Like ping(), but resolves to the bridge's /ping JSON ({ ok, version,
// bridgeVersion?, studioVersion?, features? }) or null. Never throws.
export async function pingInfo(timeoutMs = 800) {
    const r = await pingDisc(timeoutMs);
    return r && r.info;
}

// Invoke an editor operation. Resolves to the op's `result`; throws an error
// classified as described at the top of this file.
export async function op(name, args = {}, timeoutMs = 60000) {
    const disc = readDiscovery();
    if (!disc) throw notDeliveredError("bridge not running (no live discovery file)");
    const r = await httpJson(
        disc,
        "POST",
        "/op",
        { op: name, ...args },
        timeoutMs
    );
    if (r.status !== 200) {
        throw httpStatusError(r.status, r.json && r.json.error);
    }
    if (!r.json) throw ambiguousError("sent an empty reply");
    if (!r.json.ok) {
        // The bridge sends the editor's error stack; keep only the message line
        // (minus "Error: ") so live errors read like file-mode ones.
        const msg = String(r.json.error || "")
            .split("\n")[0]
            .replace(/^Error: /, "");
        const e = new Error(msg || "bridge op failed");
        e.opError = true;
        throw e;
    }
    return r.json.result;
}
