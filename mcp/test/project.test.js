// Fast unit tests for the pure JSON-manipulation library. No Electron, no
// network, no real project files. Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import * as P from "../lib/project.js";

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newProject() {
    return {
        settings: { general: { projectType: "dashboard" } },
        variables: { globalVariables: [], structures: [], enums: [] },
        userPages: []
    };
}

function projectWithPage() {
    const proj = newProject();
    P.addPage(proj, { name: "Main" });
    return proj;
}

// ---- pages ----------------------------------------------------------------

test("addPage: defaults + empty collections", () => {
    const proj = newProject();
    const page = P.addPage(proj, { name: "Main" });
    assert.equal(page.width, 480);
    assert.equal(page.height, 272);
    assert.deepEqual(page.components, []);
    assert.deepEqual(page.connectionLines, []);
    assert.deepEqual(page.localVariables, []);
    assert.equal(proj.userPages.length, 1);
});

test("addPage: initializes userPages when absent", () => {
    const proj = { settings: { general: {} } };
    P.addPage(proj, { name: "P" });
    assert.equal(proj.userPages.length, 1);
});

test("addPage: custom dimensions honored", () => {
    const proj = newProject();
    const page = P.addPage(proj, { name: "Big", width: 800, height: 600 });
    assert.equal(page.width, 800);
    assert.equal(page.height, 600);
});

test("addPage: duplicate name throws", () => {
    const proj = projectWithPage();
    assert.throws(() => P.addPage(proj, { name: "Main" }), /already exists/);
});

test("findPage: first page when no name", () => {
    const proj = projectWithPage();
    assert.equal(P.findPage(proj).name, "Main");
});

test("findPage: unknown name throws and lists existing", () => {
    const proj = projectWithPage();
    assert.throws(() => P.findPage(proj, "Nope"), /Pages: Main/);
});

test("findPage: no pages throws with (none)", () => {
    assert.throws(() => P.findPage(newProject()), /\(none\)/);
});

// ---- widgets --------------------------------------------------------------

test("addWidget: returns UUID and pushes onto page", () => {
    const proj = projectWithPage();
    const id = P.addWidget(proj, {
        page: "Main",
        type: "TextDashboardWidget",
        left: 1,
        top: 2,
        width: 3,
        height: 4
    });
    assert.match(id, UUID_RE);
    const w = P.findPage(proj, "Main").components[0];
    assert.equal(w.objID, id);
    assert.equal(w.type, "TextDashboardWidget");
    assert.deepEqual([w.left, w.top, w.width, w.height], [1, 2, 3, 4]);
});

test("addWidget: data omitted => no data key; data='' => key present", () => {
    const proj = projectWithPage();
    const id1 = P.addWidget(proj, {
        page: "Main",
        type: "T",
        left: 0,
        top: 0,
        width: 1,
        height: 1
    });
    const id2 = P.addWidget(proj, {
        page: "Main",
        type: "T",
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        data: ""
    });
    const comps = P.findPage(proj, "Main").components;
    const w1 = comps.find(c => c.objID === id1);
    const w2 = comps.find(c => c.objID === id2);
    assert.equal("data" in w1, false);
    assert.equal("data" in w2, true);
});

test("addWidget: props spread but cannot override type/objID (reserved)", () => {
    const proj = projectWithPage();
    assert.throws(
        () =>
            P.addWidget(proj, {
                page: "Main",
                type: "T",
                left: 0,
                top: 0,
                width: 1,
                height: 1,
                props: { objID: "hacked", type: "Evil" }
            }),
        /reserved field/
    );
});

test("addWidget: extra props are spread onto the widget", () => {
    const proj = projectWithPage();
    const id = P.addWidget(proj, {
        page: "Main",
        type: "T",
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        props: { style: "MyStyle" }
    });
    const w = P.findPage(proj, "Main").components.find(c => c.objID === id);
    assert.equal(w.style, "MyStyle");
});

test("addWidget: unknown page throws", () => {
    const proj = projectWithPage();
    assert.throws(
        () =>
            P.addWidget(proj, {
                page: "Ghost",
                type: "T",
                left: 0,
                top: 0,
                width: 1,
                height: 1
            }),
        /page not found/
    );
});

test("addActionComponent: distinct geometry defaults (200x60)", () => {
    const proj = projectWithPage();
    const id = P.addActionComponent(proj, {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 5,
        top: 6
    });
    const a = P.findPage(proj, "Main").components.find(c => c.objID === id);
    assert.equal(a.width, 200);
    assert.equal(a.height, 60);
});

test("updateWidget: merges props; reserved props rejected; unknown throws", () => {
    const proj = projectWithPage();
    const id = P.addWidget(proj, {
        page: "Main",
        type: "T",
        left: 0,
        top: 0,
        width: 1,
        height: 1
    });
    P.updateWidget(proj, { page: "Main", objID: id, props: { left: 99 } });
    const w = P.findPage(proj, "Main").components.find(c => c.objID === id);
    assert.equal(w.left, 99);
    assert.throws(
        () =>
            P.updateWidget(proj, {
                page: "Main",
                objID: id,
                props: { objID: "x" }
            }),
        /reserved field/
    );
    assert.throws(
        () =>
            P.updateWidget(proj, {
                page: "Main",
                objID: "nope",
                props: { left: 1 }
            }),
        /component not found/
    );
});

test("deleteWidget: removes component and its connection lines, keeps others", () => {
    const proj = projectWithPage();
    const a = P.addWidget(proj, {
        page: "Main",
        type: "ButtonDashboardWidget",
        left: 0,
        top: 0,
        width: 1,
        height: 1
    });
    const b = P.addActionComponent(proj, {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 0,
        top: 0
    });
    const c = P.addActionComponent(proj, {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 0,
        top: 0
    });
    P.connect(proj, {
        page: "Main",
        source: a,
        output: "CLICKED",
        target: b,
        input: "@seqin"
    });
    P.connect(proj, {
        page: "Main",
        source: b,
        output: "@seqout",
        target: c,
        input: "@seqin"
    });
    P.deleteWidget(proj, { page: "Main", objID: b });
    const page = P.findPage(proj, "Main");
    assert.equal(page.components.find(x => x.objID === b), undefined);
    // both lines referenced b (as target then source) => both removed
    assert.equal(page.connectionLines.length, 0);
});

test("deleteWidget: unknown objID throws", () => {
    const proj = projectWithPage();
    assert.throws(
        () => P.deleteWidget(proj, { page: "Main", objID: "nope" }),
        /component not found/
    );
});

// ---- variables ------------------------------------------------------------

test("isValidVariableType", () => {
    for (const t of ["integer", "string", "boolean", "json", "any", "date"]) {
        assert.equal(P.isValidVariableType(t), true, t);
    }
    for (const t of ["enum:Status", "struct:Point", "array:integer", "object:X"]) {
        assert.equal(P.isValidVariableType(t), true, t);
    }
    for (const t of ["", "int", "integer ", "enum:", "array:", "bogus"]) {
        assert.equal(P.isValidVariableType(t), false, t);
    }
});

test("defaultForType", () => {
    assert.equal(P.defaultForType("integer"), "0");
    assert.equal(P.defaultForType("float"), "0");
    assert.equal(P.defaultForType("double"), "0");
    assert.equal(P.defaultForType("boolean"), "false");
    assert.equal(P.defaultForType("string"), '""');
    assert.equal(P.defaultForType("array:integer"), "[]");
    assert.equal(P.defaultForType("date"), "null");
    assert.equal(P.defaultForType("json"), "null");
    assert.equal(P.defaultForType("enum:Status"), "null");
    assert.equal(P.defaultForType("struct:Point"), "null");
});

test("addVariable: defaults, dedupe, optional fields, invalid type", () => {
    const proj = newProject();
    const v = P.addVariable(proj, { name: "counter", type: "integer" });
    assert.equal(v.defaultValue, "0");
    assert.equal("description" in v, false);
    assert.equal("persistent" in v, false);

    const v2 = P.addVariable(proj, {
        name: "label",
        type: "string",
        description: "d",
        persistent: true
    });
    assert.equal(v2.defaultValue, '""');
    assert.equal(v2.description, "d");
    assert.equal(v2.persistent, true);

    assert.throws(
        () => P.addVariable(proj, { name: "counter", type: "integer" }),
        /already exists/
    );
    assert.throws(
        () => P.addVariable(proj, { name: "bad", type: "notatype" }),
        /invalid variable type/
    );
});

test("addVariable: initializes variables shell when absent", () => {
    const proj = { settings: { general: {} } };
    P.addVariable(proj, { name: "x", type: "integer" });
    assert.equal(proj.variables.globalVariables.length, 1);
});

test("bindWidget: sets data; unknown objID throws", () => {
    const proj = projectWithPage();
    const id = P.addWidget(proj, {
        page: "Main",
        type: "T",
        left: 0,
        top: 0,
        width: 1,
        height: 1
    });
    P.bindWidget(proj, { page: "Main", objID: id, expression: "counter" });
    const w = P.findPage(proj, "Main").components.find(c => c.objID === id);
    assert.equal(w.data, "counter");
    assert.throws(
        () => P.bindWidget(proj, { page: "Main", objID: "x", expression: "y" }),
        /component not found/
    );
});

// ---- flow -----------------------------------------------------------------

test("addEventHandler: defaults and action validation", () => {
    const proj = projectWithPage();
    const id = P.addWidget(proj, {
        page: "Main",
        type: "ButtonDashboardWidget",
        left: 0,
        top: 0,
        width: 1,
        height: 1
    });
    const h = P.addEventHandler(proj, { page: "Main", objID: id });
    assert.equal(h.eventName, "CLICKED");
    assert.equal(h.handlerType, "flow");
    assert.throws(
        () =>
            P.addEventHandler(proj, {
                page: "Main",
                objID: id,
                handlerType: "action"
            }),
        /requires an `action`/
    );
    const h2 = P.addEventHandler(proj, {
        page: "Main",
        objID: id,
        handlerType: "action",
        action: "DoThing"
    });
    assert.equal(h2.action, "DoThing");
});

test("connect: happy path, unknown endpoints throw, idempotent dedupe", () => {
    const proj = projectWithPage();
    const a = P.addWidget(proj, {
        page: "Main",
        type: "ButtonDashboardWidget",
        left: 0,
        top: 0,
        width: 1,
        height: 1
    });
    const b = P.addActionComponent(proj, {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 0,
        top: 0
    });
    const line = P.connect(proj, {
        page: "Main",
        source: a,
        output: "CLICKED",
        target: b,
        input: "@seqin"
    });
    assert.deepEqual(line, {
        source: a,
        output: "CLICKED",
        target: b,
        input: "@seqin",
        disabled: false
    });
    assert.equal(P.findPage(proj, "Main").connectionLines.length, 1);
    // duplicate => no new line
    P.connect(proj, {
        page: "Main",
        source: a,
        output: "CLICKED",
        target: b,
        input: "@seqin"
    });
    assert.equal(P.findPage(proj, "Main").connectionLines.length, 1);

    assert.throws(
        () =>
            P.connect(proj, {
                page: "Main",
                source: "ghost",
                output: "x",
                target: b,
                input: "@seqin"
            }),
        /source component not found/
    );
    assert.throws(
        () =>
            P.connect(proj, {
                page: "Main",
                source: a,
                output: "CLICKED",
                target: "ghost",
                input: "@seqin"
            }),
        /target component not found/
    );
});

test("disconnect: removes matching line, returns count", () => {
    const proj = projectWithPage();
    const a = P.addWidget(proj, {
        page: "Main",
        type: "ButtonDashboardWidget",
        left: 0,
        top: 0,
        width: 1,
        height: 1
    });
    const b = P.addActionComponent(proj, {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 0,
        top: 0
    });
    P.connect(proj, {
        page: "Main",
        source: a,
        output: "CLICKED",
        target: b,
        input: "@seqin"
    });
    const removed = P.disconnect(proj, {
        page: "Main",
        source: a,
        output: "CLICKED",
        target: b,
        input: "@seqin"
    });
    assert.equal(removed, 1);
    assert.equal(P.findPage(proj, "Main").connectionLines.length, 0);
    assert.equal(
        P.disconnect(proj, {
            page: "Main",
            source: a,
            output: "CLICKED",
            target: b,
            input: "@seqin"
        }),
        0
    );
});

// ---- schema helpers (fixture schema, no generated catalog) ----------------

const fixtureSchema = {
    widgets: [
        {
            type: "TextDashboardWidget",
            category: "widget",
            properties: [
                { name: "data", eezType: "ObjectReference", serialized: true },
                { name: "secret", eezType: "X", serialized: false }
            ]
        }
    ],
    actionComponents: [
        {
            type: "SetVariableActionComponent",
            category: "actionComponent",
            properties: [{ name: "entries", eezType: "Array" }]
        }
    ]
};

test("listComponentTypes: filters by kind", () => {
    assert.equal(P.listComponentTypes(fixtureSchema, "widget").length, 1);
    assert.equal(
        P.listComponentTypes(fixtureSchema, "actionComponent").length,
        1
    );
    assert.equal(P.listComponentTypes(fixtureSchema, "all").length, 2);
});

test("getComponentSchema: drops non-serialized props; unknown throws", () => {
    const s = P.getComponentSchema(fixtureSchema, "TextDashboardWidget");
    assert.deepEqual(
        s.properties.map(p => p.name),
        ["data"]
    );
    assert.throws(
        () => P.getComponentSchema(fixtureSchema, "Nope"),
        /unknown component type/
    );
});

test("validateComponent: unknown type and unknown props", () => {
    assert.equal(
        P.validateComponent(fixtureSchema, "Nope", {}).ok,
        false
    );
    const r = P.validateComponent(fixtureSchema, "TextDashboardWidget", {
        data: "x",
        bogus: 1
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.unknownProps, ["bogus"]);
});
