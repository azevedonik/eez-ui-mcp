// live-ops.js — the editor operations the bridge performs against the RUNNING
// EEZ Studio. Everything here calls the editor's own operation layer (the same
// functions the palette / property grid / flow editor invoke), so edits are
// undoable, run the class hooks/validation, and re-render live via MobX:
//
//   add component   createObject(palette factory) + projectStore.addObject(page.components)
//   set / bind      projectStore.updateObject(obj, {...})  (+ checkExpression for feedback)
//   add variable    createObject(Variable) + addObject(globalVariables)
//   connect         createObject(ConnectionLine) + addObject(page.connectionLines)
//   delete          projectStore.deleteObject(obj)
//   reveal          navigationStore.showObjects([obj], openEditor, nav, select)
//   render          @electron/remote webContents.capturePage(rect)
//
// App modules resolve via app-module-path (build/ is a global module root), so
// `require("project-editor/store")` etc. return the SAME live singletons.

"use strict";

// --- lazy app-module access ------------------------------------------------
// Required lazily (inside the renderer) so loading this file in the main
// process is harmless.

let _app = null;
function app() {
    if (_app) return _app;
    // App's OWN modules resolve via app-module-path (build/ is a global root).
    _app = {
        tabsStore: require("home/tabs-store"),
        store: require("project-editor/store"),
        serialization: require("project-editor/store/serialization"),
        object: require("project-editor/core/object"),
        helper: require("project-editor/store/helper"),
        check: safeRequire("project-editor/flow/expression/check")
    };
    return _app;
}

function safeRequire(id) {
    try {
        return require(id);
    } catch (e) {
        return null;
    }
}

// The extension lives outside the app tree, so npm dependencies (mobx,
// @electron/remote, ...) are not on its require path. Resolve them through the
// app's node_modules (derived from an app module's resolved location).
let _appNodeModules = null;
function appNodeModules() {
    if (_appNodeModules) return _appNodeModules;
    const path = require("path");
    const p = require.resolve("home/tabs-store"); // <repo>/build/home/tabs-store.js
    _appNodeModules = path.join(
        path.dirname(path.dirname(path.dirname(p))),
        "node_modules"
    );
    return _appNodeModules;
}

function dep(name) {
    try {
        return require(name);
    } catch (e) {
        return require(require.resolve(name, { paths: [appNodeModules()] }));
    }
}

function getRemote() {
    if (typeof EEZStudio !== "undefined" && EEZStudio && EEZStudio.remote) {
        return EEZStudio.remote;
    }
    return dep("@electron/remote");
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(cond, timeoutMs, intervalMs) {
    const t = timeoutMs || 15000;
    const step = intervalMs || 100;
    const start = Date.now();
    for (;;) {
        let v;
        try {
            v = cond();
        } catch (e) {
            v = undefined;
        }
        if (v) return v;
        if (Date.now() - start > t) throw new Error("timed out waiting for editor");
        await delay(step);
    }
}

// --- project / page / object resolution ------------------------------------

function samePath(a, b) {
    if (!a || !b) return false;
    return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

// Resolve (opening if needed) the live ProjectStore for a project file.
async function resolveStore(projectPath) {
    const { tabsStore } = app();
    const { tabs, openProject } = tabsStore;
    if (!tabs) throw new Error("EEZ Studio tabs not ready");

    if (projectPath) {
        // Find an already-open editor tab for this path, else open it.
        let tab = tabs.tabs.find(
            t => t.projectStore && samePath(t.projectStore.filePath, projectPath)
        );
        if (!tab) {
            openProject(projectPath, false);
            tab = await waitFor(
                () =>
                    tabs.tabs.find(
                        t =>
                            t.projectStore &&
                            samePath(t.projectStore.filePath, projectPath)
                    ),
                20000
            );
        }
        if (tab.makeActive) tab.makeActive();
        const store = await waitFor(() => tab.projectStore, 20000);
        await waitFor(() => store.project, 20000);
        return store;
    }

    // No path given: use the active tab.
    const tab = tabs.activeTab;
    const store = tab && tab.projectStore;
    if (!store || !store.project) {
        throw new Error(
            "no active project; pass `project` (a .eez-project path) or open one in EEZ Studio"
        );
    }
    return store;
}

function listPagesOf(store) {
    // `userPages` is the real observable array; `project.pages` is a computed
    // copy (userPages + userWidgets), so mutating it is a no-op.
    return store.project.userPages || [];
}

function findPage(store, name) {
    const pages = listPagesOf(store);
    const page = name ? pages.find(p => p.name === name) : pages[0];
    if (!page) {
        const names = pages.map(p => p.name).join(", ") || "(none)";
        throw new Error(`page not found: ${name || "(first page)"}. Pages: ${names}`);
    }
    return page;
}

// Find a component on a page by its persistent objID (recursing into children).
function findByObjID(page, objID) {
    const stack = [...(page.components || [])];
    while (stack.length) {
        const c = stack.shift();
        if (!c) continue;
        if (c.objID === objID) return c;
        if (Array.isArray(c.components)) stack.push(...c.components);
        if (Array.isArray(c.widgets)) stack.push(...c.widgets);
    }
    throw new Error(`component not found on page "${page.name}": ${objID}`);
}

function classFor(store, type) {
    const aClass = app().object.getClassByName(store, type);
    if (!aClass) throw new Error(`unknown component/class type: ${type}`);
    return aClass;
}

// Reveal a freshly-changed object so the user sees it (opens editor, selects,
// ensures visible). Best-effort: never fail an op because reveal failed.
function reveal(store, obj) {
    try {
        if (store.navigationStore && store.navigationStore.showObjects) {
            store.navigationStore.showObjects([obj], true, true, true);
        }
    } catch (e) {
        /* ignore */
    }
}

// Per-call context. A single op gets none; `batch` passes
// `{ store, noReveal: true }` so every op reuses the store it resolved once
// (no per-op tab lookup / makeActive) and nothing is revealed mid-batch —
// `show()` just remembers the object, and batch reveals it once at the end.
async function storeFor(project, ctx) {
    return ctx && ctx.store ? ctx.store : resolveStore(project);
}

function show(ctx, store, obj) {
    if (ctx && ctx.noReveal) {
        ctx.lastShown = obj;
        return;
    }
    reveal(store, obj);
}

// Props that must never go through updateObject: rewriting objID would orphan
// every connection line / reference to the component, and `type` selects the
// class. updateObject splits keys on "." and uses the first part, so check that.
const RESERVED_PROPS = ["objID", "type"];

function assertNoReservedProps(props) {
    if (!props || typeof props !== "object") return;
    const bad = RESERVED_PROPS.filter(r =>
        Object.keys(props).some(k => k.split(".")[0] === r)
    );
    if (bad.length) {
        throw new Error(
            `props may not set ${bad.join("/")}: objID is the component's identity ` +
                "(connections reference it) and type is fixed; delete and re-add " +
                "the component to change its type"
        );
    }
}

// Run a compound edit as a single undo entry. Nests: inside an already-open
// group (e.g. runAtomic) it neither opens nor closes anything.
function combined(store, fn) {
    const um = store.undoManager;
    let close = false;
    if (um && !um.combineCommands) {
        um.setCombineCommands(true);
        close = true;
    }
    try {
        return fn();
    } finally {
        if (close && um) um.setCombineCommands(false);
    }
}

function errMsg(e) {
    return e && e.message ? e.message : String(e);
}

// Run `fn` (may be async) as ONE undo step, all-or-nothing. Relies on
// UndoManager internals (project-editor/store/undo-manager.ts, unchanged
// 0.28.0-0.29.0):
//  - setCombineCommands(true) first flushes any pending (uncombined) user
//    command from um.commands into undoStack, so afterwards um.commands holds
//    ONLY our commands. Hence: never baseline on undoStack.length — a pending
//    user edit would make the stack "grow" and we would undo the user's edit.
//  - nested combined()/addObject/deleteObject/updateObject see
//    combineCommands === true and leave the group open.
//  - on failure: close the group (pushes our commands as one undo item), then
//    undo() it and drop it from redoStack so it can't be redone.
async function runAtomic(store, fn) {
    const um = store && store.undoManager;
    if (!um) throw new Error("project has no undo manager");
    if (um.combineCommands || um.postponeSetCombineCommandsFalse) {
        const busy = new Error(
            "editor busy: another edit is in progress in EEZ Studio (undo group open); retry"
        );
        busy.code = "EDITOR_BUSY";
        throw busy;
    }
    um.setCombineCommands(true);
    try {
        return await fn();
    } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const dirty = um.commands.length > 0;
        um.setCombineCommands(false);
        if (dirty) {
            try {
                um.undo();
                um.redoStack.pop();
            } catch (ue) {
                err.rollbackError = ue;
            }
        }
        throw err;
    } finally {
        // Guarantee the group is closed whatever happened above.
        if (um.combineCommands) {
            try {
                um.setCombineCommands(false);
            } catch (e) {
                /* fall through to the hard reset */
            }
            if (um.combineCommands) um.combineCommands = false;
        }
    }
}

// --- batch helpers (pure; unit-tested in mcp/test/live-ops.test.js) --------
// KEEP IN SYNC with resolveRefs / batch validation in mcp/lib/project.js.

const BATCH_OPS = [
    "addPage",
    "addWidget",
    "addActionComponent",
    "updateWidget",
    "deleteWidget",
    "addVariable",
    "bindWidget",
    "addEventHandler",
    "connect",
    "disconnect"
];
// Ops whose result carries the created component's objID (may set `as`).
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALIAS_OPS = ["addWidget", "addActionComponent"];
// The only arg fields in which "$alias" is substituted.
const REF_FIELDS = ["objID", "source", "target"];
const MAX_BATCH_OPS = 200;

function aliasOf(v) {
    return typeof v === "string" && v.length > 1 && v[0] === "$" ? v.slice(1) : null;
}

// Return a shallow copy of `args` with objID/source/target values that are
// exactly "$name" replaced by refs[name]. Throws on an undefined alias.
function resolveRefs(args, refs) {
    if (!args || typeof args !== "object") return args;
    const out = Object.assign({}, args);
    for (const f of REF_FIELDS) {
        const a = aliasOf(out[f]);
        if (a === null) continue;
        if (!refs || !Object.prototype.hasOwnProperty.call(refs, a)) {
            throw new Error(`undefined reference "$${a}" in ${f}`);
        }
        out[f] = refs[a];
    }
    return out;
}

// Validate a whole batch BEFORE anything is applied. Op numbers in messages
// are 1-based (#1 = first op). Returns normalized [{ op, args, as }].
function validateBatch(list) {
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error("batch: `ops` must be a non-empty array; nothing applied");
    }
    if (list.length > MAX_BATCH_OPS) {
        throw new Error(
            `batch: at most ${MAX_BATCH_OPS} ops per batch (got ${list.length}); nothing applied`
        );
    }
    const defined = new Set();
    return list.map((item, i) => {
        const name = item && typeof item === "object" ? item.op : undefined;
        const fail = msg =>
            new Error(`batch op #${i + 1} (${name || "?"}) invalid: ${msg}; nothing applied`);
        if (!item || typeof item !== "object") throw fail("must be an object { op, args, as? }");
        if (!BATCH_OPS.includes(name)) {
            throw fail(`unsupported op; allowed: ${BATCH_OPS.join(", ")}`);
        }
        const args = item.args === undefined ? {} : item.args;
        if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw fail("args must be an object");
        }
        for (const f of REF_FIELDS) {
            const a = aliasOf(args[f]);
            if (a !== null && !defined.has(a)) {
                throw fail(`${f} references "$${a}", which no earlier op defines with \`as\``);
            }
        }
        if (name === "updateWidget") {
            try {
                assertNoReservedProps(args.props);
            } catch (e) {
                throw fail(errMsg(e));
            }
        }
        if (item.as !== undefined) {
            if (typeof item.as !== "string" || !item.as || item.as[0] === "$") {
                throw fail("`as` must be a non-empty name without a leading $");
            }
            if (!ALIAS_RE.test(item.as)) {
                throw fail(`invalid alias "${item.as}" (use letters, digits, _)`);
            }
            if (!ALIAS_OPS.includes(name)) {
                throw fail(`\`as\` is only supported on ${ALIAS_OPS.join(", ")}`);
            }
            if (defined.has(item.as)) throw fail(`duplicate alias "${item.as}"`);
            defined.add(item.as);
        }
        // The batch targets one project; a per-op `project` is ignored.
        const clean = Object.assign({}, args);
        delete clean.project;
        return { op: name, args: clean, as: item.as };
    });
}

// --- operations ------------------------------------------------------------

const ops = {
    async status({ project }) {
        const store = await resolveStore(project);
        const g = store.project.settings && store.project.settings.general;
        return {
            projectFilePath: store.filePath,
            projectType: g ? g.projectType : null,
            isModified: store.isModified,
            pages: listPagesOf(store).map(p => p.name)
        };
    },

    // Reload an open project tab from disk (used after the file is recreated /
    // changed underneath a stale editor tab). Opens it if not already open.
    async reloadProject({ project }) {
        const store = await resolveStore(project);
        try {
            app().tabsStore.tabs.reloadProject(store);
        } catch (e) {
            /* best effort */
        }
        return { reloaded: store.filePath };
    },

    // Run EEZ Studio's semantic checks (the "Checks" panel) and return the
    // diagnostics as a flat, structured list so Claude can see + fix issues
    // (e.g. an invalid style/variable reference). Also refreshes the live panel.
    async getChecks({ project }) {
        const store = await resolveStore(project);
        const { backgroundCheck } = require("project-editor/build/build");
        const { getParent } = app().object;
        const tree = backgroundCheck(store) || []; // GROUP-tree of Message
        const TYPE = ["info", "error", "warning", "search", "group"];

        const nearestObjID = obj => {
            let o = obj;
            while (o) {
                if (o.objID) return o.objID;
                o = getParent(o);
            }
            return undefined;
        };

        const flat = [];
        const walk = (msgs, crumb) => {
            for (const m of msgs || []) {
                const label = m.text;
                const isGroup = m.messages && m.messages.length;
                const path = crumb && label ? crumb + " / " + label : crumb || label;
                if (isGroup) {
                    walk(m.messages, path);
                } else {
                    flat.push({
                        type: TYPE[m.type] || String(m.type),
                        message: label,
                        location: crumb || undefined,
                        objID: m.object ? nearestObjID(m.object) : undefined
                    });
                }
            }
        };
        walk(tree, "");

        return {
            errors: flat.filter(c => c.type === "error").length,
            warnings: flat.filter(c => c.type === "warning").length,
            total: flat.length,
            checks: flat
        };
    },

    async listPages({ project }) {
        const store = await resolveStore(project);
        return {
            pages: listPagesOf(store).map(p => ({
                name: p.name,
                width: p.width,
                height: p.height,
                widgetCount: (p.components || []).length
            }))
        };
    },

    async addPage({ project, name, width, height }, ctx) {
        const store = await storeFor(project, ctx);
        if (listPagesOf(store).find(p => p.name === name)) {
            throw new Error(`page already exists: ${name}`);
        }
        const { createObject } = app().serialization;
        const PageClass = classFor(store, "Page");
        const page = createObject(
            store,
            {
                name,
                left: 0,
                top: 0,
                width: width || 480,
                height: height || 272,
                components: [],
                connectionLines: []
            },
            PageClass
        );
        combined(store, () => store.addObject(store.project.userPages, page));
        show(ctx, store, page);
        return { added: name };
    },

    async addWidget(args, ctx) {
        return addComponent(args, { defW: 100, defH: 40 }, ctx);
    },

    async addActionComponent(args, ctx) {
        return addComponent(args, { defW: 200, defH: 60 }, ctx);
    },

    async updateWidget({ project, page, objID, props }, ctx) {
        assertNoReservedProps(props);
        const store = await storeFor(project, ctx);
        const pg = findPage(store, page);
        const comp = findByObjID(pg, objID);
        combined(store, () => store.updateObject(comp, props || {}));
        show(ctx, store, comp);
        return { updated: objID };
    },

    async bindWidget({ project, page, objID, expression }, ctx) {
        const store = await storeFor(project, ctx);
        const pg = findPage(store, page);
        const comp = findByObjID(pg, objID);
        const warnings = [];
        const check = app().check;
        if (check && check.checkExpression) {
            try {
                check.checkExpression(comp, expression);
            } catch (e) {
                warnings.push(`expression may be invalid: ${e}`);
            }
        }
        combined(store, () => store.updateObject(comp, { data: expression }));
        show(ctx, store, comp);
        return { bound: objID, data: expression, warnings };
    },

    async deleteWidget({ project, page, objID }, ctx) {
        const store = await storeFor(project, ctx);
        const pg = findPage(store, page);
        const comp = findByObjID(pg, objID);
        combined(store, () => store.deleteObject(comp));
        if (ctx && ctx.lastShown === comp) ctx.lastShown = null;
        return { deleted: objID };
    },

    async listWidgets({ project, page }) {
        const store = await resolveStore(project);
        const pg = findPage(store, page);
        return {
            widgets: (pg.components || []).map(c => ({
                objID: c.objID,
                type: c.type,
                left: c.left,
                top: c.top,
                width: c.width,
                height: c.height,
                data: c.data
            }))
        };
    },

    async addVariable({ project, name, type, defaultValue, description, persistent }, ctx) {
        const store = await storeFor(project, ctx);
        const vars = store.project.variables;
        if (!vars || !vars.globalVariables) {
            throw new Error("project has no variables section");
        }
        if (vars.globalVariables.find(v => v.name === name)) {
            throw new Error(`variable already exists: ${name}`);
        }
        const { createObject } = app().serialization;
        const VariableClass = classFor(store, "Variable");
        const js = { name, type: type || "string" };
        if (defaultValue !== undefined) js.defaultValue = defaultValue;
        if (description) js.description = description;
        if (persistent) js.persistent = true;
        const v = createObject(store, js, VariableClass);
        combined(store, () => store.addObject(vars.globalVariables, v));
        show(ctx, store, v);
        return { added: v.name, type: v.type, defaultValue: v.defaultValue };
    },

    async listVariables({ project }) {
        const store = await resolveStore(project);
        const vars = (store.project.variables && store.project.variables.globalVariables) || [];
        return {
            variables: vars.map(v => ({
                name: v.name,
                type: v.type,
                defaultValue: v.defaultValue
            }))
        };
    },

    async addEventHandler({ project, page, objID, eventName, handlerType, action }, ctx) {
        const store = await storeFor(project, ctx);
        const pg = findPage(store, page);
        const comp = findByObjID(pg, objID);
        const ht = handlerType || "flow";
        if (ht === "action" && !action) {
            throw new Error('handlerType "action" requires an `action` name');
        }
        const { createObject } = app().serialization;
        const { findPropertyByNameInObject } = app().helper;
        const pi = findPropertyByNameInObject(comp, "eventHandlers");
        if (!pi || !pi.typeClass) {
            throw new Error(`component does not support event handlers: ${comp.type}`);
        }
        const js = { eventName: eventName || "CLICKED", handlerType: ht };
        if (ht === "action") js.action = action;
        const eh = createObject(store, js, pi.typeClass);
        if (!comp.eventHandlers) {
            combined(store, () => store.updateObject(comp, { eventHandlers: [] }));
        }
        combined(store, () => store.addObject(comp.eventHandlers, eh));
        show(ctx, store, comp);
        return { widget: objID, eventName: js.eventName, handlerType: ht };
    },

    async connect({ project, page, source, output, target, input }, ctx) {
        const store = await storeFor(project, ctx);
        const pg = findPage(store, page);
        // Validate both endpoints exist (raises a clear error otherwise).
        findByObjID(pg, source);
        findByObjID(pg, target);
        const existing = (pg.connectionLines || []).find(
            cl =>
                cl.source === source &&
                cl.output === output &&
                cl.target === target &&
                cl.input === input
        );
        if (existing) {
            return { connected: `${source}.${output} -> ${target}.${input}`, duplicate: true };
        }
        const { createObject } = app().serialization;
        const CLClass = classFor(store, "ConnectionLine");
        const cl = createObject(
            store,
            { source, output, target, input, disabled: false },
            CLClass
        );
        combined(store, () => store.addObject(pg.connectionLines, cl));
        return { connected: `${source}.${output} -> ${target}.${input}` };
    },

    async disconnect({ project, page, source, output, target, input }, ctx) {
        const store = await storeFor(project, ctx);
        const pg = findPage(store, page);
        const matches = (pg.connectionLines || []).filter(
            cl =>
                cl.source === source &&
                cl.output === output &&
                cl.target === target &&
                cl.input === input
        );
        combined(store, () => {
            for (const cl of matches) store.deleteObject(cl);
        });
        return { removed: matches.length };
    },

    // Apply many authoring ops as ONE undo step, all-or-nothing.
    //   args: { project?, ops: [{ op, args, as? }] }   (1..MAX_BATCH_OPS ops)
    //   op is one of BATCH_OPS; `as` (addWidget/addActionComponent only) names the
    //   created objID so a LATER op can pass "$name" as objID/source/target.
    //   -> { applied, results: [{ index, op, as?, ...opResult }], refs }
    // `index` and the "#k" in errors are 1-based. On any failure everything
    // already applied is rolled back and the error reads
    // "batch op #k (<op>) failed: <msg>; nothing applied". The store is resolved
    // once and only the last created/updated object is revealed, after success.
    async batch({ project, ops: list }, ctx) {
        const plan = validateBatch(list);
        const store = await storeFor(project, ctx);
        const sub = { store, noReveal: true, lastShown: null };
        const refs = {};
        const results = [];
        try {
            await runAtomic(store, async () => {
                for (let i = 0; i < plan.length; i++) {
                    const { op, args, as } = plan[i];
                    try {
                        const r = (await ops[op](resolveRefs(args, refs), sub)) || {};
                        if (as) {
                            if (!r.objID) throw new Error(`no objID returned for alias "${as}"`);
                            refs[as] = r.objID;
                        }
                        results.push(Object.assign({ index: i + 1, op }, as ? { as } : {}, r));
                    } catch (e) {
                        const err = e instanceof Error ? e : new Error(String(e));
                        err.batchIndex = i;
                        throw err;
                    }
                }
            });
        } catch (e) {
            if (e.code === "EDITOR_BUSY") throw new Error(`batch refused: ${errMsg(e)}; nothing applied`);
            const where =
                e.batchIndex !== undefined
                    ? `batch op #${e.batchIndex + 1} (${plan[e.batchIndex].op}) failed`
                    : "batch failed";
            if (e.rollbackError) {
                throw new Error(
                    `${where}: ${errMsg(e)}; ROLLBACK FAILED (${errMsg(e.rollbackError)}): ` +
                        "the editor may hold a partial edit, use Undo in EEZ Studio"
                );
            }
            throw new Error(`${where}: ${errMsg(e)}; nothing applied`);
        }
        if (sub.lastShown && !(ctx && ctx.noReveal)) reveal(store, sub.lastShown);
        return { applied: results.length, results, refs };
    },

    async listConnections({ project, page }) {
        const store = await resolveStore(project);
        const pg = findPage(store, page);
        return {
            connections: (pg.connectionLines || []).map(cl => ({
                source: cl.source,
                output: cl.output,
                target: cl.target,
                input: cl.input
            }))
        };
    },

    async save({ project }) {
        const store = await resolveStore(project);
        const { save: saveProject } = app().store;
        await saveProject(store, store.filePath);
        return { saved: store.filePath };
    },

    // Build the project in-app (same as the editor's Build action) and return
    // the Output panel messages + a success flag. No headless CLI needed.
    async build({ project }) {
        const store = await resolveStore(project);
        const { save: saveProject, Section } = app().store;
        await saveProject(store, store.filePath);
        await store.build();
        const section = store.outputSectionsStore.sections[Section.OUTPUT];
        const lines = [];
        const collect = (msgs, indent) => {
            for (const m of msgs || []) {
                lines.push(indent + m.text);
                if (m.messages) collect(m.messages, indent + "  ");
            }
        };
        collect(section.messages.messages, "");
        const output = lines.join("\n");
        const success =
            /successfully finished/i.test(output) &&
            !/unhandled error/i.test(output) &&
            section.messages.numErrors === 0;
        return { success, output, errors: section.messages.numErrors };
    },

    // Validate that the saved project re-loads and re-serializes cleanly through
    // EEZ Studio's own loader (a throwaway store, so the live editor is untouched).
    async validate({ project }) {
        const store = await resolveStore(project);
        const { save: saveProject, ProjectStore, getJSON } = app().store;
        await saveProject(store, store.filePath);
        try {
            const probe = ProjectStore.create({ type: "project-editor" });
            await probe.openFile(store.filePath);
            getJSON(probe, 2);
            return { valid: true };
        } catch (e) {
            return { valid: false, output: String((e && e.stack) || e) };
        }
    },

    async render({ project, page, mode }) {
        const store = await resolveStore(project);
        const pg = findPage(store, page);
        // Open + reveal the page so the canvas is mounted and showing it.
        reveal(store, pg);
        if (store.editorsStore && store.editorsStore.openEditor) {
            store.editorsStore.openEditor(pg);
        }
        if ((mode || "design") === "run") {
            return await renderRun(store, pg);
        }
        return await renderDesign();
    }
};

async function addComponent(
    { project, page, type, left, top, width, height, data, props },
    defs,
    ctx
) {
    assertNoReservedProps(props);
    const store = await storeFor(project, ctx);
    const pg = findPage(store, page);
    const aClass = classFor(store, type);
    const { createObject } = app().serialization;
    const js = Object.assign({}, props || {}, {
        type,
        left: left || 0,
        top: top || 0,
        width: width || defs.defW,
        height: height || defs.defH
    });
    if (data !== undefined) js.data = data;
    const comp = createObject(store, js, aClass);
    combined(store, () => store.addObject(pg.components, comp));
    show(ctx, store, comp);
    return { objID: comp.objID };
}

// --- capture (ported from packages/home/render-project.ts) -----------------

const WAIT_PAINT_MS = 600;
const RUNTIME_PAINT_MS = 2500;

function largestFlowContainer() {
    const els = Array.from(document.querySelectorAll(".EezStudio_FlowCanvasContainer"));
    let best = null;
    let bestArea = 0;
    for (const el of els) {
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
            bestArea = area;
            best = el;
        }
    }
    return best;
}

async function capturePageRect(rect) {
    const win = getRemote().getCurrentWindow();
    const image = await win.webContents.capturePage({
        x: Math.max(0, Math.floor(rect.x)),
        y: Math.max(0, Math.floor(rect.y)),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height)
    });
    return image.toPNG().toString("base64");
}

async function renderDesign() {
    await waitFor(() => document.querySelector(".EezStudio_FlowCanvasContainer"), 15000);
    await delay(WAIT_PAINT_MS);
    const best = largestFlowContainer();
    if (!best) throw new Error("flow canvas container not found");
    return { mode: "design", png: await capturePageRect(best.getBoundingClientRect()) };
}

async function renderRun(store, pg) {
    const { runInAction } = dep("mobx");
    runInAction(() => store.setRuntimeMode(false));
    try {
        await waitFor(() => store.runtime, 15000);
        try {
            runInAction(() => (store.runtime.selectedPage = pg));
        } catch (e) {
            /* ignore */
        }
        if (store.editorsStore && store.editorsStore.openEditor) {
            store.editorsStore.openEditor(pg);
        }
        await waitFor(() => document.querySelector(".EezStudio_FlowCanvasContainer"), 15000);
        await delay(RUNTIME_PAINT_MS);
        const canvas = document.querySelector("canvas");
        if (canvas) {
            const dataUrl = canvas.toDataURL("image/png");
            return { mode: "run", png: dataUrl.replace(/^data:image\/png;base64,/, "") };
        }
        const best = largestFlowContainer();
        if (!best) throw new Error("runtime view has no size");
        return { mode: "run", png: await capturePageRect(best.getBoundingClientRect()) };
    } finally {
        try {
            await store.setEditorMode(true);
        } catch (e) {
            /* ignore */
        }
    }
}

// --- dispatch --------------------------------------------------------------

async function dispatch(op, args) {
    const fn = ops[op];
    if (!fn) throw new Error("unknown op: " + op);
    return await fn(args || {});
}

module.exports = {
    dispatch,
    ops,
    getRemote, // also used by index.js for the Studio version
    // pure helpers, exported for unit tests (mcp/test/live-ops.test.js)
    resolveRefs,
    runAtomic,
    validateBatch,
    assertNoReservedProps,
    BATCH_OPS,
    MAX_BATCH_OPS
};
