// Unit tests for lib/bridge-client.js — discovery resolution and the
// transport-vs-opError classification the backend relies on. No live app and
// no network server are required (the "not running" paths are deterministic).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

// Point discovery at a path that does not exist so "no bridge" is deterministic.
delete process.env.EEZ_BRIDGE_URL;
delete process.env.EEZ_BRIDGE_TOKEN;
process.env.EEZ_BRIDGE_DISCOVERY = path.join(
    os.tmpdir(),
    `eez-bridge-absent-${process.pid}.json`
);

const bridge = await import("../lib/bridge-client.js");

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
        delete process.env.EEZ_BRIDGE_URL;
        delete process.env.EEZ_BRIDGE_TOKEN;
    }
});

test("ping resolves to null when the bridge is not running", async () => {
    assert.equal(await bridge.ping(200), null);
});

test("op rejects with a transport error when the bridge is not running", async () => {
    await assert.rejects(
        () => bridge.op("status", {}),
        e => e.transport === true && !e.opError
    );
});
