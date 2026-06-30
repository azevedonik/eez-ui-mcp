// Unit tests for lib/backend.js fallback routing. With no live app reachable,
// authoring verbs must take the FILE path (lib/project.js) and tag results
// `via:"file"`. These paths touch only the filesystem (no Electron).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
