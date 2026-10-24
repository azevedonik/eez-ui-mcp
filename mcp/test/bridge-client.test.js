// Unit tests for lib/bridge-client.js — discovery resolution (incl. dead-pid
// detection) and the error classification the backend relies on:
// notDelivered (safe to fall back) / ambiguous (sent, may have applied) /
// httpStatus (non-200, not applied) / opError. Uses local stub HTTP servers;
// no live app is required.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

// Point discovery at a path that does not exist so "no bridge" is deterministic.
delete process.env.EEZ_BRIDGE_URL;
delete process.env.EEZ_BRIDGE_TOKEN;
process.env.EEZ_BRIDGE_DISCOVERY = path.join(
    os.tmpdir(),
    `eez-bridge-absent-${process.pid}.json`
);
const DISC = process.env.EEZ_BRIDGE_DISCOVERY;

const bridge = await import("../lib/bridge-client.js");

// --- helpers ---------------------------------------------------------------

// Start an HTTP stub on an ephemeral port; returns { port, server, close }.
async function stub(handler) {
    const server = http.createServer(handler);
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    return {
        port,
        server,
        close: () =>
            new Promise(r => {
                server.closeAllConnections && server.closeAllConnections();
                server.close(() => r());
            })
    };
}

// Point the client at 127.0.0.1:port via the env override (no pid check).
function useUrl(port) {
    process.env.EEZ_BRIDGE_URL = `http://127.0.0.1:${port}`;
    process.env.EEZ_BRIDGE_TOKEN = "tok";
}
function clearUrl() {
    delete process.env.EEZ_BRIDGE_URL;
    delete process.env.EEZ_BRIDGE_TOKEN;
}

// A port that nothing listens on (bind, read port, close).
async function closedPort() {
    const s = net.createServer();
    await new Promise(r => s.listen(0, "127.0.0.1", r));
    const port = s.address().port;
    await new Promise(r => s.close(r));
    return port;
}

// The pid of a process that has already exited.
async function deadPid() {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise(r => child.on("exit", r));
    return pid;
}

// --- basics ----------------------------------------------------------------

test("transportError carries the transport flag", () => {
    const e = bridge.transportError("nope");
    assert.equal(e.transport, true);
    assert.equal(e.message, "nope");
    assert.ok(e instanceof Error);
});

test("readDiscovery returns null with no file and no env override", () => {
    assert.equal(bridge.readDiscovery(), null);
});

test("readDiscovery honors EEZ_BRIDGE_URL/EEZ_BRIDGE_TOKEN", () => {
    process.env.EEZ_BRIDGE_URL = "http://127.0.0.1:40404";
    process.env.EEZ_BRIDGE_TOKEN = "s3cret";
    try {
        const d = bridge.readDiscovery();
        assert.equal(d.host, "127.0.0.1");
        assert.equal(d.port, 40404);
        assert.equal(d.token, "s3cret");
    } finally {
        clearUrl();
    }
});

test("ping resolves to null when the bridge is not running", async () => {
    assert.equal(await bridge.ping(200), null);
});

test("op rejects with a notDelivered transport error when the bridge is not running", async () => {
    await assert.rejects(
        () => bridge.op("status", {}),
        e => e.transport === true && e.notDelivered === true && !e.opError
    );
});

// --- discovery liveness ----------------------------------------------------

test("readDiscovery: dead pid -> null quickly, with no network call", async () => {
    let hits = 0;
    const s = await stub((req, res) => {
        hits++;
        res.end("{}");
    });
    try {
        const pid = await deadPid();
        fs.writeFileSync(DISC, JSON.stringify({ port: s.port, token: "t", pid }));
        const t0 = performance.now();
        assert.equal(bridge.readDiscovery(), null);
        await assert.rejects(() => bridge.op("listPages", {}), e => e.notDelivered === true);
        assert.equal(await bridge.ping(), null);
        const ms = performance.now() - t0;
        assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
        assert.equal(hits, 0, "no request may reach the stub");
    } finally {
        fs.rmSync(DISC, { force: true });
        await s.close();
    }
});

test("readDiscovery: live pid or missing pid -> discovery record", () => {
    try {
        fs.writeFileSync(DISC, JSON.stringify({ port: 1, token: "t", pid: process.pid }));
        assert.equal(bridge.readDiscovery().pid, process.pid);
        fs.writeFileSync(DISC, JSON.stringify({ port: 1, token: "t" })); // old bridge
        assert.equal(bridge.readDiscovery().port, 1);
    } finally {
        fs.rmSync(DISC, { force: true });
    }
});

// --- error classes ---------------------------------------------------------

test("closed port -> notDelivered", { timeout: 20000 }, async () => {
    useUrl(await closedPort());
    try {
        await assert.rejects(
            () => bridge.op("addPage", { name: "X" }, 10000),
            e => e.notDelivered === true && !e.ambiguous && !e.opError
        );
    } finally {
        clearUrl();
    }
});

test("accepted but never answered -> ambiguous (not notDelivered)", async () => {
    let got = 0;
    const s = await stub(() => {
        got++; // swallow: never respond
    });
    useUrl(s.port);
    try {
        await assert.rejects(
            () => bridge.op("addPage", { name: "X" }, 300),
            e =>
                e.ambiguous === true &&
                !e.notDelivered &&
                /may have applied/.test(e.message)
        );
        assert.equal(got, 1);
    } finally {
        clearUrl();
        await s.close();
    }
});

test("connection reset after delivery -> ambiguous", async () => {
    const s = await stub(req => req.socket.destroy());
    useUrl(s.port);
    try {
        await assert.rejects(
            () => bridge.op("addPage", { name: "X" }, 5000),
            e => e.ambiguous === true && !e.notDelivered
        );
    } finally {
        clearUrl();
        await s.close();
    }
});

test("HTTP 401 -> httpStatus error, not applied, stale-token hint", async () => {
    const s = await stub((req, res) => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing or bad token" }));
    });
    useUrl(s.port);
    try {
        await assert.rejects(
            () => bridge.op("addPage", { name: "X" }),
            e =>
                e.httpStatus === 401 &&
                !e.notDelivered &&
                !e.ambiguous &&
                /not applied/.test(e.message) &&
                /restart/i.test(e.message)
        );
    } finally {
        clearUrl();
        await s.close();
    }
});

test("HTTP 200 {ok:false} -> opError", async () => {
    const s = await stub((req, res) => {
        res.end(JSON.stringify({ ok: false, error: "page not found: X" }));
    });
    useUrl(s.port);
    try {
        await assert.rejects(
            () => bridge.op("addWidget", {}),
            e => e.opError === true && e.message === "page not found: X"
        );
    } finally {
        clearUrl();
        await s.close();
    }
});

test("response split inside a multibyte UTF-8 char round-trips", async () => {
    const label = "Ação concluída ✓ 日本語 " + "é".repeat(5000);
    const s = await stub((req, res) => {
        const buf = Buffer.from(JSON.stringify({ ok: true, result: { label } }), "utf8");
        // split inside the 3-byte "✓"
        const cut = buf.indexOf(Buffer.from("✓", "utf8")) + 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(buf.subarray(0, cut));
        setTimeout(() => res.end(buf.subarray(cut)), 20);
    });
    useUrl(s.port);
    try {
        const r = await bridge.op("listPages", {});
        assert.equal(r.label, label);
    } finally {
        clearUrl();
        await s.close();
    }
});

test("pingInfo returns the /ping JSON", async () => {
    const s = await stub((req, res) => {
        res.end(JSON.stringify({ ok: true, bridgeVersion: "0.2.0", studioVersion: "0.29.0" }));
    });
    useUrl(s.port);
    try {
        const info = await bridge.pingInfo();
        assert.equal(info.bridgeVersion, "0.2.0");
        assert.equal(info.studioVersion, "0.29.0");
        assert.ok(await bridge.ping());
    } finally {
        clearUrl();
        await s.close();
    }
});
