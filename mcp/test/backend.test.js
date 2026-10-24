// Unit tests for lib/backend.js fallback routing. With no live app reachable,
// authoring verbs must take the FILE path (lib/project.js) and tag results
// `via:"file"`. Bridge errors that are not "never delivered" (ambiguous
// timeout, non-200) must NOT fall back. Stub HTTP servers stand in for the
// bridge (via EEZ_BRIDGE_URL); no Electron.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";

// Force "no live app": discovery points at a nonexistent file.
delete process.env.EEZ_BRIDGE_URL;
delete process.env.EEZ_BRIDGE_TOKEN;
process.env.EEZ_BRIDGE_DISCOVERY = path.join(
    os.tmpdir(),
    `eez-bridge-absent-backend-${process.pid}.json`
);

const backend = await import("../lib/backend.js");

function tempProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eez-backend-"));
    const p = path.join(dir, "t.eez-project");
    fs.writeFileSync(
        p,
        JSON.stringify({
            settings: { general: { projectType: "dashboard" } },
            userPages: [],
            variables: { globalVariables: [], structures: [], enums: [] }
        })
    );
    return p;
}

test("isLive is falsy when no bridge is running", async () => {
    assert.ok(!(await backend.isLive()));
});

test("addPage falls back to file and persists", async () => {
    const p = tempProject();
    const r = await backend.addPage(p, { name: "Main", width: 480, height: 272 });
    assert.equal(r.via, "file");
    assert.equal(r.added, "Main");
    const proj = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(proj.userPages.length, 1);
    assert.equal(proj.userPages[0].name, "Main");
});

test("addWidget + bindWidget + connect round-trip on the file path", async () => {
    const p = tempProject();
    await backend.addPage(p, { name: "Main" });
    await backend.addVariable(p, { name: "counter", type: "integer", defaultValue: "0" });

    const w = await backend.addWidget(p, {
        page: "Main",
        type: "TextDashboardWidget",
        left: 0,
        top: 0,
        width: 100,
        height: 30,
        props: {}
    });
    assert.equal(w.via, "file");
    assert.ok(w.objID);

    const btn = await backend.addWidget(p, {
        page: "Main",
        type: "ButtonDashboardWidget",
        left: 0,
        top: 40,
        width: 120,
        height: 40,
        props: {}
    });
    const act = await backend.addActionComponent(p, {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 200,
        top: 40,
        props: {}
    });

    const bind = await backend.bindWidget(p, {
        page: "Main",
        objID: w.objID,
        expression: "counter"
    });
    assert.equal(bind.via, "file");

    const conn = await backend.connect(p, {
        page: "Main",
        source: btn.objID,
        output: "CLICKED",
        target: act.objID,
        input: "@seqin"
    });
    assert.equal(conn.via, "file");

    const widgets = await backend.listWidgets(p, { page: "Main" });
    assert.equal(widgets.via, "file");
    assert.equal(widgets.widgets.length, 3);

    const conns = await backend.listConnections(p, { page: "Main" });
    assert.equal(conns.connections.length, 1);

    // bound expression landed on disk
    const proj = JSON.parse(fs.readFileSync(p, "utf8"));
    const textWidget = proj.userPages[0].components.find(c => c.objID === w.objID);
    assert.equal(textWidget.data, "counter");
});

test("save on the file path is a no-op that reports via:file", async () => {
    const p = tempProject();
    const r = await backend.save(p);
    assert.equal(r.via, "file");
    assert.equal(r.saved, p);
});

// --- stub bridge helpers ---------------------------------------------------

async function stub(handler) {
    const server = http.createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", d => (body += d));
        req.on("end", () => handler(req, res, body ? JSON.parse(body) : null));
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    process.env.EEZ_BRIDGE_URL = `http://127.0.0.1:${port}`;
    process.env.EEZ_BRIDGE_TOKEN = "tok";
    return () =>
        new Promise(r => {
            delete process.env.EEZ_BRIDGE_URL;
            delete process.env.EEZ_BRIDGE_TOKEN;
            server.closeAllConnections && server.closeAllConnections();
            server.close(() => r());
        });
}

function reply(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

// Count fs.writeFileSync calls on `file` while fn runs.
async function countWrites(file, fn) {
    const orig = fs.writeFileSync;
    let n = 0;
    fs.writeFileSync = function (p, ...rest) {
        if (path.resolve(String(p)) === path.resolve(file)) n++;
        return orig.call(this, p, ...rest);
    };
    try {
        const result = await fn();
        return { n, result };
    } finally {
        fs.writeFileSync = orig;
    }
}

const SIX_OPS = [
    { tool: "add_page", args: { name: "Main" } },
    { tool: "add_variable", args: { name: "counter", type: "integer", defaultValue: "0" } },
    {
        tool: "add_widget",
        args: { page: "Main", type: "TextDashboardWidget", left: 0, top: 0, width: 100, height: 30, data: "counter", props: {} }
    },
    {
        tool: "add_widget",
        as: "btn",
        args: { page: "Main", type: "ButtonDashboardWidget", left: 0, top: 40, width: 120, height: 40, props: {} }
    },
    {
        tool: "add_action_component",
        as: "act",
        args: { page: "Main", type: "SetVariableActionComponent", left: 200, top: 40, props: {} }
    },
    {
        tool: "connect",
        args: { page: "Main", source: "$btn", output: "CLICKED", target: "$act", input: "@seqin" }
    }
];

// --- batch -----------------------------------------------------------------

test("batch on the file path: one write, via:file, aliases resolved", async () => {
    const p = tempProject();
    const { n, result: r } = await countWrites(p, () => backend.batch(p, SIX_OPS));
    assert.equal(n, 1, "project file written exactly once");
    assert.equal(r.via, "file");
    assert.equal(r.applied, 6);
    assert.deepEqual(r.results.map(x => x.tool), SIX_OPS.map(o => o.tool));
    assert.ok(r.refs.btn && r.refs.act);
    const proj = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(proj.userPages[0].components.length, 3);
    const cl = proj.userPages[0].connectionLines[0];
    assert.equal(cl.source, r.refs.btn);
    assert.equal(cl.target, r.refs.act);
});

test("batch on the file path: failure writes nothing", async () => {
    const p = tempProject();
    const before = fs.readFileSync(p, "utf8");
    const ops = [
        { tool: "add_page", args: { name: "Main" } },
        { tool: "add_widget", args: { page: "Nope", type: "TextDashboardWidget", left: 0, top: 0, width: 1, height: 1 } }
    ];
    const { n } = await countWrites(p, () =>
        assert.rejects(() => backend.batch(p, ops), /batch op #2 \(add_widget\) failed: .*nothing applied/)
    );
    assert.equal(n, 0);
    assert.equal(fs.readFileSync(p, "utf8"), before);
});

test("batch live: one bridge request with op names, results mapped back to tools", async () => {
    let seen = null;
    const close = await stub((req, res, body) => {
        seen = body;
        reply(res, 200, {
            ok: true,
            result: {
                applied: 2,
                results: [
                    { index: 1, op: "addPage", added: "Main" },
                    { index: 2, op: "addWidget", as: "t", objID: "id-1" }
                ],
                refs: { t: "id-1" }
            }
        });
    });
    try {
        const p = tempProject();
        const before = fs.readFileSync(p, "utf8");
        const r = await backend.batch(p, [
            { tool: "add_page", args: { name: "Main" } },
            { tool: "add_widget", as: "t", args: { page: "Main", type: "TextDashboardWidget", left: 0, top: 0, width: 1, height: 1, props: {} } }
        ]);
        assert.equal(seen.op, "batch");
        assert.equal(seen.project, p);
        assert.deepEqual(seen.ops.map(o => o.op), ["addPage", "addWidget"]);
        assert.equal(seen.ops[1].as, "t");
        assert.equal(seen.ops[0].as, undefined);
        assert.equal(r.via, "live-editor");
        assert.equal(r.applied, 2);
        assert.deepEqual(r.results[1], { index: 2, tool: "add_widget", as: "t", objID: "id-1" });
        assert.deepEqual(r.refs, { t: "id-1" });
        assert.equal(fs.readFileSync(p, "utf8"), before, "file untouched in live mode");
    } finally {
        await close();
    }
});

test("batch against an old bridge -> update hint, no file fallback", async () => {
    const close = await stub((req, res) =>
        reply(res, 200, { ok: false, error: "Error: unknown op: batch\n    at dispatch (live-ops.js:885)" })
    );
    try {
        const p = tempProject();
        const before = fs.readFileSync(p, "utf8");
        await assert.rejects(
            () => backend.batch(p, SIX_OPS),
            e => /install\.mjs/.test(e.message) && /restart EEZ Studio/.test(e.message)
        );
        assert.equal(fs.readFileSync(p, "utf8"), before);
    } finally {
        await close();
    }
});

// --- routing safety --------------------------------------------------------

test("ambiguous (delivered, then reset) live error is not routed to file", async () => {
    // backend uses the default 60 s op timeout; reset the socket instead so the
    // test is fast: the request was delivered, then the connection died.
    const close = await stub(req => req.socket.destroy());
    try {
        const p = tempProject();
        const before = fs.readFileSync(p, "utf8");
        await assert.rejects(
            () => backend.addPage(p, { name: "Main" }),
            e => e.ambiguous === true && /may have applied/.test(e.message)
        );
        await assert.rejects(() => backend.batch(p, SIX_OPS), e => e.ambiguous === true);
        assert.equal(fs.readFileSync(p, "utf8"), before);
    } finally {
        await close();
    }
});

test("batch live: op error keeps first line only, bridge op name mapped to tool name", async () => {
    const close = await stub((req, res) =>
        reply(res, 200, {
            ok: false,
            error:
                "Error: batch op #2 (deleteWidget) failed: widget not found: w9; nothing applied\n" +
                "    at Object.deleteWidget (C:\eez\live-ops.js:1:1)\n    at runAtomic (C:\eez\live-ops.js:2:2)"
        })
    );
    try {
        const p = tempProject();
        const before = fs.readFileSync(p, "utf8");
        await assert.rejects(
            () => backend.batch(p, SIX_OPS),
            e =>
                e.message ===
                "batch op #2 (delete_widget) failed: widget not found: w9; nothing applied"
        );
        assert.equal(fs.readFileSync(p, "utf8"), before);
    } finally {
        await close();
    }
});

test("HTTP 401 from the bridge -> not applied, no file fallback", async () => {
    const close = await stub((req, res) => reply(res, 401, { ok: false, error: "missing or bad token" }));
    try {
        const p = tempProject();
        const before = fs.readFileSync(p, "utf8");
        await assert.rejects(
            () => backend.addPage(p, { name: "Main" }),
            e => e.httpStatus === 401 && /not applied/.test(e.message)
        );
        await assert.rejects(() => backend.save(p), e => e.httpStatus === 401);
        assert.equal(fs.readFileSync(p, "utf8"), before);
    } finally {
        await close();
    }
});

test("connection refused (not delivered) -> file fallback; live-only verb says it needs the app", { timeout: 20000 }, async () => {
    const s = net.createServer();
    await new Promise(r => s.listen(0, "127.0.0.1", r));
    const port = s.address().port;
    await new Promise(r => s.close(r));
    process.env.EEZ_BRIDGE_URL = `http://127.0.0.1:${port}`;
    process.env.EEZ_BRIDGE_TOKEN = "tok";
    try {
        const p = tempProject();
        const r = await backend.addPage(p, { name: "Main" });
        assert.equal(r.via, "file");
        await assert.rejects(() => backend.getChecks(p), /needs EEZ Studio running/);
    } finally {
        delete process.env.EEZ_BRIDGE_URL;
        delete process.env.EEZ_BRIDGE_TOKEN;
    }
});

// --- bridge status ---------------------------------------------------------

test("compareVersions", () => {
    assert.ok(backend.compareVersions("0.1.0", "0.2.0") < 0);
    assert.equal(backend.compareVersions("0.2.0", "0.2.0"), 0);
    assert.ok(backend.compareVersions("0.10.0", "0.2.0") > 0);
    assert.ok(backend.compareVersions("1.0", "0.9.9") > 0);
});

test("bridgeStatus: current bridge -> versions, no warning; old bridge -> warning", async () => {
    let pingBody = { ok: true, version: "0.2.0", bridgeVersion: "0.2.0", studioVersion: "0.29.0" };
    const close = await stub((req, res) => reply(res, 200, pingBody));
    try {
        assert.deepEqual(await backend.bridgeStatus(), {
            studioVersion: "0.29.0",
            bridgeVersion: "0.2.0"
        });
        pingBody = { ok: true, version: "0.1.0" }; // 0.1.0 bridge ping shape
        const old = await backend.bridgeStatus();
        assert.equal(old.bridgeVersion, "0.1.0");
        assert.equal(old.studioVersion, null);
        assert.match(old.warning, /older than 0\.2\.0/);
        assert.match(old.warning, /install\.mjs/);
    } finally {
        await close();
    }
    assert.equal(await backend.bridgeStatus(), null); // nothing reachable
});
