// Unit tests for the pure batch helpers in extension/live-ops.js (resolveRefs,
// validateBatch, runAtomic) and the batch op itself against a fake store. No
// Electron: live-ops.js loads EEZ Studio's app modules lazily, so requiring it
// in plain Node is safe as long as no op touches app().
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const L = require("../../extension/live-ops.js");

// --- stub UndoManager: a JS port of project-editor/store/undo-manager.ts ----
// (0.28.0 == 0.29.0) minus mobx and selection tracking. Counts undo() calls.

class StubUndoManager {
    constructor() {
        this.undoStack = [];
        this.redoStack = [];
        this.commands = [];
        this.combineCommands = false;
        this.postponeSetCombineCommandsFalse = false;
        this.undoCalls = 0;
        this.setCombineCalls = 0;
    }
    pushToUndoStack() {
        if (this.commands.length > 0) {
            this.undoStack.push({ commands: this.commands });
            this.commands = [];
        }
    }
    setCombineCommands(value) {
        this.setCombineCalls++;
        if (value == false && this.postponeSetCombineCommandsFalse) return;
        this.pushToUndoStack();
        this.combineCommands = value;
    }
    executeCommand(command) {
        if (this.commands.length != 0 && !this.combineCommands) {
            this.pushToUndoStack();
        }
        command.execute();
        this.commands.push(command);
        this.redoStack = [];
    }
    undo() {
        this.undoCalls++;
        this.pushToUndoStack();
        const item = this.undoStack.pop();
        if (item) {
            for (let i = item.commands.length - 1; i >= 0; i--) item.commands[i].undo();
            this.redoStack.push(item);
        }
    }
}

// A command that sets state[key] = value (and restores the previous value).
function setCmd(state, key, value) {
    let prev;
    return {
        description: `set ${key}`,
        execute() {
            prev = state[key];
            state[key] = value;
        },
        undo() {
            state[key] = prev;
        }
    };
}

function storeWith(um) {
    return { undoManager: um || new StubUndoManager() };
}

// --- resolveRefs -------------------------------------------------------------

test("resolveRefs substitutes objID/source/target only, exact $alias match", () => {
    const refs = { btn: "uuid-btn", act: "uuid-act" };
    const args = {
        page: "$btn",
        objID: "$btn",
        source: "$btn",
        target: "$act",
        data: "$btn",
        props: { objID: "$btn" },
        output: "clicked"
    };
    const out = L.resolveRefs(args, refs);
    assert.equal(out.objID, "uuid-btn");
    assert.equal(out.source, "uuid-btn");
    assert.equal(out.target, "uuid-act");
    // Not a ref field / nested: untouched.
    assert.equal(out.page, "$btn");
    assert.equal(out.data, "$btn");
    assert.deepEqual(out.props, { objID: "$btn" });
    assert.equal(out.output, "clicked");
    // Input not mutated.
    assert.equal(args.objID, "$btn");
});

test("resolveRefs leaves plain values, '$' alone and non-strings unchanged", () => {
    const out = L.resolveRefs({ objID: "abc-123", source: "$", target: 5 }, {});
    assert.deepEqual(out, { objID: "abc-123", source: "$", target: 5 });
    assert.equal(L.resolveRefs(undefined, {}), undefined);
});

test("resolveRefs throws on an undefined alias", () => {
    assert.throws(() => L.resolveRefs({ target: "$nope" }, { btn: "x" }), /undefined reference "\$nope"/);
    assert.throws(() => L.resolveRefs({ objID: "$btn" }, undefined), /undefined reference/);
    // Inherited properties are not aliases.
    assert.throws(() => L.resolveRefs({ objID: "$toString" }, {}), /undefined reference/);
});

// --- runAtomic ---------------------------------------------------------------

test("runAtomic success: all commands become ONE undo group, group closed", async () => {
    const um = new StubUndoManager();
    const state = {};
    const r = await L.runAtomic(storeWith(um), async () => {
        um.executeCommand(setCmd(state, "a", 1));
        um.executeCommand(setCmd(state, "b", 2));
        return "ok";
    });
    assert.equal(r, "ok");
    assert.equal(um.combineCommands, false);
    assert.equal(um.commands.length, 0);
    assert.equal(um.undoStack.length, 1);
    assert.equal(um.undoStack[0].commands.length, 2);
    assert.deepEqual(state, { a: 1, b: 2 });
    assert.equal(um.undoCalls, 0);
});

test("runAtomic failure with no commands executed: nothing undone", async () => {
    const um = new StubUndoManager();
    const state = { x: "user" };
    um.undoStack.push({ commands: [setCmd({}, "old", 1)] });
    await assert.rejects(
        L.runAtomic(storeWith(um), async () => {
            throw new Error("boom");
        }),
        /boom/
    );
    assert.equal(um.undoCalls, 0);
    assert.equal(um.undoStack.length, 1);
    assert.equal(um.combineCommands, false);
    assert.deepEqual(state, { x: "user" });
});

test("runAtomic: pending user command survives when op #1 fails (R1)", async () => {
    const um = new StubUndoManager();
    const state = {};
    // A user edit still sitting in um.commands (not yet pushed to undoStack).
    um.executeCommand(setCmd(state, "user", "edit"));
    assert.equal(um.undoStack.length, 0);
    assert.equal(um.commands.length, 1);

    await assert.rejects(
        L.runAtomic(storeWith(um), async () => {
            throw new Error("component not found");
        }),
        /component not found/
    );
    assert.equal(um.undoCalls, 0, "undo must not be called");
    assert.equal(state.user, "edit", "user edit survives");
    assert.equal(um.undoStack.length, 1, "user edit is its own undo step");
    assert.equal(um.combineCommands, false);
});

test("runAtomic: pending user command survives when ours ran then failed", async () => {
    const um = new StubUndoManager();
    const state = {};
    um.executeCommand(setCmd(state, "user", "edit"));
    await assert.rejects(
        L.runAtomic(storeWith(um), async () => {
            um.executeCommand(setCmd(state, "ours", 1));
            throw new Error("later op failed");
        })
    );
    assert.equal(um.undoCalls, 1);
    assert.equal(state.user, "edit");
    assert.equal(state.ours, undefined);
    assert.equal(um.undoStack.length, 1);
    assert.equal(um.undoStack[0].commands[0].description, "set user");
    assert.equal(um.redoStack.length, 0);
});

test("runAtomic: two commands then failure -> undone once, redo popped", async () => {
    const um = new StubUndoManager();
    const state = { a: 0 };
    await assert.rejects(
        L.runAtomic(storeWith(um), async () => {
            um.executeCommand(setCmd(state, "a", 1));
            um.executeCommand(setCmd(state, "b", 2));
            throw new Error("partway");
        }),
        /partway/
    );
    assert.equal(um.undoCalls, 1);
    assert.deepEqual(state, { a: 0, b: undefined });
    assert.equal(um.undoStack.length, 0);
    assert.equal(um.redoStack.length, 0, "rolled-back group is not redoable");
    assert.equal(um.commands.length, 0);
    assert.equal(um.combineCommands, false);
});

test("runAtomic refuses when an undo group is already open (editor busy)", async () => {
    for (const flag of ["combineCommands", "postponeSetCombineCommandsFalse"]) {
        const um = new StubUndoManager();
        um[flag] = true;
        let ran = false;
        await assert.rejects(
            L.runAtomic(storeWith(um), async () => {
                ran = true;
            }),
            e => e.code === "EDITOR_BUSY" && /editor busy/.test(e.message)
        );
        assert.equal(ran, false);
        assert.equal(um.setCombineCalls, 0, `${flag}: undo manager untouched`);
        assert.equal(um[flag], true);
    }
});

test("runAtomic always resets combineCommands after a throw", async () => {
    const um = new StubUndoManager();
    await assert.rejects(
        L.runAtomic(storeWith(um), () => {
            throw "not an Error"; // eslint-disable-line no-throw-literal
        }),
        e => e instanceof Error && e.message === "not an Error"
    );
    assert.equal(um.combineCommands, false);

    // Even if something sets postpone mid-run so setCombineCommands(false) is
    // ignored, the group is force-closed.
    const um2 = new StubUndoManager();
    await assert.rejects(
        L.runAtomic(storeWith(um2), async () => {
            um2.postponeSetCombineCommandsFalse = true;
            throw new Error("x");
        })
    );
    assert.equal(um2.combineCommands, false);
});

test("runAtomic reports a failed rollback instead of hiding it", async () => {
    const um = new StubUndoManager();
    um.undo = () => {
        throw new Error("undo exploded");
    };
    await assert.rejects(
        L.runAtomic(storeWith(um), async () => {
            um.executeCommand(setCmd({}, "a", 1));
            throw new Error("op failed");
        }),
        e => e.message === "op failed" && /undo exploded/.test(String(e.rollbackError))
    );
    assert.equal(um.combineCommands, false);
});

// --- validateBatch -----------------------------------------------------------

test("validateBatch accepts backward references and strips per-op project", () => {
    const plan = L.validateBatch([
        { op: "addWidget", args: { project: "x.eez-project", type: "TextWidget" }, as: "lbl" },
        { op: "addActionComponent", args: { type: "LogActionComponent" }, as: "log" },
        { op: "connect", args: { source: "$lbl", output: "clicked", target: "$log", input: "@seqin" } },
        { op: "deleteWidget" }
    ]);
    assert.equal(plan.length, 4);
    assert.equal(plan[0].args.project, undefined);
    assert.equal(plan[0].as, "lbl");
    assert.deepEqual(plan[3].args, {});
});

test("validateBatch rejects duplicate, forward, self and undefined aliases (1-based #k)", () => {
    assert.throws(
        () =>
            L.validateBatch([
                { op: "addWidget", args: { type: "TextWidget" }, as: "a" },
                { op: "addWidget", args: { type: "TextWidget" }, as: "a" }
            ]),
        /^Error: batch op #2 \(addWidget\) invalid: duplicate alias "a"; nothing applied$/
    );
    assert.throws(
        () =>
            L.validateBatch([
                { op: "updateWidget", args: { objID: "$b", props: {} } },
                { op: "addWidget", args: { type: "TextWidget" }, as: "b" }
            ]),
        /batch op #1 \(updateWidget\) invalid: objID references "\$b", which no earlier op defines/
    );
    assert.throws(
        () => L.validateBatch([{ op: "addWidget", args: { type: "T", objID: "$me" }, as: "me" }]),
        /#1 .*references "\$me"/
    );
    assert.throws(
        () =>
            L.validateBatch([
                { op: "addWidget", args: { type: "T" }, as: "a" },
                { op: "connect", args: { source: "$a", target: "$zzz" } }
            ]),
        /batch op #2 \(connect\) invalid: target references "\$zzz"/
    );
});

test("validateBatch enforces size, op names, `as` placement and reserved props", () => {
    const many = Array.from({ length: L.MAX_BATCH_OPS + 1 }, () => ({ op: "deleteWidget", args: {} }));
    assert.equal(L.MAX_BATCH_OPS, 200);
    assert.throws(() => L.validateBatch(many), /at most 200 ops/);
    assert.equal(L.validateBatch(many.slice(1)).length, 200);
    assert.throws(() => L.validateBatch([]), /non-empty array/);
    assert.throws(() => L.validateBatch(undefined), /non-empty array/);
    assert.throws(() => L.validateBatch([{ op: "batch", args: {} }]), /#1 \(batch\) invalid: unsupported op/);
    assert.throws(() => L.validateBatch([{ op: "save" }]), /unsupported op/);
    assert.throws(() => L.validateBatch([null]), /#1 \(\?\) invalid/);
    assert.throws(() => L.validateBatch([{ op: "addPage", args: [] }]), /args must be an object/);
    assert.throws(
        () => L.validateBatch([{ op: "addPage", args: { name: "P" }, as: "p" }]),
        /`as` is only supported on addWidget, addActionComponent/
    );
    assert.throws(
        () => L.validateBatch([{ op: "addWidget", args: { type: "T" }, as: "$x" }]),
        /without a leading \$/
    );
    assert.throws(
        () => L.validateBatch([{ op: "updateWidget", args: { objID: "u", props: { type: "X" } } }]),
        /#1 \(updateWidget\) invalid: props may not set type/
    );
});

test("validateBatch rejects aliases outside [A-Za-z_][A-Za-z0-9_]*", () => {
    for (const as of ["1a", "a-b", "a b", "a.b"]) {
        assert.throws(
            () => L.validateBatch([{ op: "addWidget", args: { type: "T" }, as }]),
            e => e.message === `batch op #1 (addWidget) invalid: invalid alias "${as}" (use letters, digits, _); nothing applied`
        );
    }
    assert.equal(L.validateBatch([{ op: "addWidget", args: { type: "T" }, as: "_ok1" }]).length, 1);
});

test("BATCH_OPS are all real ops", () => {
    for (const name of L.BATCH_OPS) assert.equal(typeof L.ops[name], "function", name);
});

// --- updateWidget reserved props ---------------------------------------------

test("updateWidget rejects objID / type (incl. dotted) before touching the editor", async () => {
    for (const props of [{ objID: "new" }, { type: "ButtonWidget" }, { "objID.x": 1 }]) {
        await assert.rejects(L.ops.updateWidget({ objID: "u1", props }), /props may not set/);
    }
    // addWidget / addActionComponent spread props into the new object: same guard.
    for (const op of ["addWidget", "addActionComponent"]) {
        for (const props of [{ objID: "x" }, { type: "ButtonWidget" }, { "type.y": 1 }]) {
            await assert.rejects(L.ops[op]({ page: "Main", type: "T", props }), /props may not set/);
        }
    }
    assert.doesNotThrow(() => L.assertNoReservedProps({ text: "hi", "style.color": "red" }));
    assert.doesNotThrow(() => L.assertNoReservedProps(undefined));
});

// --- batch op end to end against a fake store ---------------------------------
// updateWidget/deleteWidget/disconnect need no app modules, so they can run
// against a fake ProjectStore whose edits go through the stub undo manager.

function fakeStore() {
    const um = new StubUndoManager();
    const w1 = { objID: "w1", text: "one" };
    const w2 = { objID: "w2", text: "two" };
    const page = { name: "Main", components: [w1, w2], connectionLines: [] };
    const revealed = [];
    const store = {
        undoManager: um,
        project: { userPages: [page] },
        navigationStore: { showObjects: objs => revealed.push(...objs) },
        updateObject(obj, values) {
            for (const [k, v] of Object.entries(values)) um.executeCommand(setCmd(obj, k, v));
        },
        deleteObject(obj) {
            const arr = page.components;
            let idx;
            um.executeCommand({
                description: "delete",
                execute() {
                    idx = arr.indexOf(obj);
                    arr.splice(idx, 1);
                },
                undo() {
                    arr.splice(idx, 0, obj);
                }
            });
        }
    };
    return { store, um, w1, w2, page, revealed };
}

test("batch success: one undo step, 1-based results, single reveal of last object", async () => {
    const f = fakeStore();
    const r = await L.ops.batch(
        {
            ops: [
                { op: "updateWidget", args: { page: "Main", objID: "w1", props: { text: "A" } } },
                { op: "updateWidget", args: { page: "Main", objID: "w2", props: { text: "B" } } },
                { op: "disconnect", args: { page: "Main", source: "w1", output: "o", target: "w2", input: "i" } }
            ]
        },
        { store: f.store }
    );
    assert.equal(r.applied, 3);
    assert.deepEqual(r.refs, {});
    assert.deepEqual(
        r.results.map(x => [x.index, x.op]),
        [
            [1, "updateWidget"],
            [2, "updateWidget"],
            [3, "disconnect"]
        ]
    );
    assert.equal(r.results[0].updated, "w1");
    assert.equal(r.results[2].removed, 0);
    assert.equal(f.w1.text, "A");
    assert.equal(f.w2.text, "B");
    assert.equal(f.um.undoStack.length, 1, "whole batch = one undo step");
    assert.equal(f.um.combineCommands, false);
    assert.deepEqual(f.revealed, [f.w2], "revealed once, last updated object");
});

test("batch failure at op #2 rolls back op #1 and says nothing applied", async () => {
    const f = fakeStore();
    await assert.rejects(
        L.ops.batch(
            {
                ops: [
                    { op: "updateWidget", args: { page: "Main", objID: "w1", props: { text: "A" } } },
                    { op: "deleteWidget", args: { page: "Main", objID: "missing" } }
                ]
            },
            { store: f.store }
        ),
        /^Error: batch op #2 \(deleteWidget\) failed: component not found on page "Main": missing; nothing applied$/
    );
    assert.equal(f.w1.text, "one");
    assert.equal(f.page.components.length, 2);
    assert.equal(f.um.undoStack.length, 0);
    assert.equal(f.um.redoStack.length, 0);
    assert.equal(f.um.combineCommands, false);
    assert.deepEqual(f.revealed, [], "nothing revealed on failure");
});

test("batch refuses while the editor has an open undo group", async () => {
    const f = fakeStore();
    f.um.combineCommands = true;
    await assert.rejects(
        L.ops.batch(
            { ops: [{ op: "updateWidget", args: { page: "Main", objID: "w1", props: { text: "A" } } }] },
            { store: f.store }
        ),
        /^Error: batch refused: editor busy.*; nothing applied$/
    );
    assert.equal(f.w1.text, "one");
});

test("batch validates aliases before resolving the project", async () => {
    // No ctx.store: if validation did not run first, resolveStore would try
    // to load EEZ Studio's modules and fail with a different error.
    await assert.rejects(
        L.ops.batch({ ops: [{ op: "connect", args: { source: "$nope", target: "x" } }] }),
        /batch op #1 \(connect\) invalid: source references "\$nope"/
    );
});
