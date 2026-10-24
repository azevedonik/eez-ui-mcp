// Pure manipulation of a .eez-project JSON document (Dashboard projects).
//
// No EEZ Studio runtime is needed here: this writes the documented
// serialization format directly. Components that participate in flows get
// explicit objIDs (UUIDs) so connectionLines can reference them; EEZ Studio
// preserves provided objIDs on load, so the references stay valid.
//
// Every function operates on a plain in-memory project object; only load/save
// and loadSchema touch the filesystem. That keeps the logic unit-testable
// without Electron.
import fs from "fs";
import { randomUUID } from "crypto";

/**
 * @typedef {Object} Widget A serialized widget/component.
 * @property {string} type Registered class name, e.g. "TextDashboardWidget".
 * @property {string} objID Stable unique id (referenced by connectionLines).
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {string} [data] Expression bound to the widget's data input.
 *
 * @typedef {Object} ConnectionLine
 * @property {string} source Source component objID.
 * @property {string} output Source output pin name.
 * @property {string} target Target component objID.
 * @property {string} input Target input pin name.
 * @property {boolean} disabled
 *
 * @typedef {Object} Page
 * @property {string} name
 * @property {number} width
 * @property {number} height
 * @property {Widget[]} components
 * @property {ConnectionLine[]} connectionLines
 * @property {object[]} localVariables
 *
 * @typedef {Object} Project The parsed .eez-project document.
 */

// Identity fields that callers must not override via `props`.
const RESERVED_PROPS = ["objID", "type"];

// Recognized variable type strings (basic) and complex prefixes.
const BASIC_TYPES = new Set([
    "integer",
    "float",
    "double",
    "boolean",
    "string",
    "date",
    "blob",
    "stream",
    "widget",
    "json",
    "event",
    "any"
]);
const COMPLEX_PREFIXES = ["enum:", "struct:", "object:", "array:"];

// ---- io -------------------------------------------------------------------

/** @param {string} projectPath @returns {Project} */
export function load(projectPath) {
    return JSON.parse(fs.readFileSync(projectPath, "utf8"));
}

/** @param {string} projectPath @param {Project} project */
export function save(projectPath, project) {
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), "utf8");
}

// ---- lookup helpers -------------------------------------------------------

/** @returns {Page} @throws if the page does not exist */
export function findPage(project, name) {
    const pages = project.userPages || [];
    const page = name ? pages.find(p => p.name === name) : pages[0];
    if (!page) {
        const names = pages.map(p => p.name).join(", ") || "(none)";
        throw new Error(
            `page not found: ${name || "(first page)"}. Pages: ${names}`
        );
    }
    return page;
}

function findComponent(page, objID) {
    const c = (page.components || []).find(c => c.objID === objID);
    if (!c) {
        throw new Error(`component not found on page "${page.name}": ${objID}`);
    }
    return c;
}

/**
 * Throw if `props` tries to set identity fields (objID / type). Shared by
 * addWidget / addActionComponent / updateWidget and by the MCP layer.
 * @param {object} [props]
 */
export function assertNoReservedProps(props) {
    if (!props || typeof props !== "object") return;
    const offending = RESERVED_PROPS.filter(r =>
        Object.keys(props).some(k => k.split(".")[0] === r)
    );
    if (offending.length) {
        throw new Error(
            `props may not set reserved field(s): ${offending.join(", ")}`
        );
    }
}

// ---- pages ----------------------------------------------------------------

export function addPage(project, { name, width = 480, height = 272 }) {
    project.userPages = project.userPages || [];
    if (project.userPages.find(p => p.name === name)) {
        throw new Error(`page already exists: ${name}`);
    }
    const page = {
        name,
        left: 0,
        top: 0,
        width,
        height,
        components: [],
        connectionLines: [],
        localVariables: []
    };
    project.userPages.push(page);
    return page;
}

export function listPages(project) {
    return (project.userPages || []).map(p => ({
        name: p.name,
        width: p.width,
        height: p.height,
        widgetCount: (p.components || []).length
    }));
}

// ---- widgets / components -------------------------------------------------

export function addWidget(
    project,
    { page, type, left = 0, top = 0, width = 100, height = 40, data, props = {} }
) {
    assertNoReservedProps(props);
    const p = findPage(project, page);
    const objID = randomUUID();
    // props first so authoritative identity/geometry fields win.
    const widget = { ...props, type, objID, left, top, width, height };
    if (data !== undefined) widget.data = data;
    p.components = p.components || [];
    p.components.push(widget);
    return objID;
}

export function addActionComponent(
    project,
    { page, type, left = 0, top = 0, width = 200, height = 60, props = {} }
) {
    assertNoReservedProps(props);
    const p = findPage(project, page);
    const objID = randomUUID();
    const action = { ...props, type, objID, left, top, width, height };
    p.components = p.components || [];
    p.components.push(action);
    return objID;
}

export function updateWidget(project, { page, objID, props }) {
    assertNoReservedProps(props);
    const p = findPage(project, page);
    const c = findComponent(p, objID);
    Object.assign(c, props);
    return c;
}

export function deleteWidget(project, { page, objID }) {
    const p = findPage(project, page);
    const i = (p.components || []).findIndex(c => c.objID === objID);
    if (i < 0) throw new Error(`component not found: ${objID}`);
    p.components.splice(i, 1);
    // Drop connection lines that referenced the removed component.
    p.connectionLines = (p.connectionLines || []).filter(
        cl => cl.source !== objID && cl.target !== objID
    );
}

export function listWidgets(project, { page }) {
    const p = findPage(project, page);
    return (p.components || []).map(c => ({
        objID: c.objID,
        type: c.type,
        left: c.left,
        top: c.top,
        width: c.width,
        height: c.height,
        data: c.data,
        eventHandlers: c.eventHandlers
    }));
}

// ---- variables + binding --------------------------------------------------

export function isValidVariableType(type) {
    if (typeof type !== "string" || type.length === 0) return false;
    if (BASIC_TYPES.has(type)) return true;
    return COMPLEX_PREFIXES.some(
        prefix => type.startsWith(prefix) && type.length > prefix.length
    );
}

// Sensible default-value expression for a variable of the given type. EEZ
// stores defaultValue as an expression string; "null" is a valid "unset" for
// any reference/complex type.
export function defaultForType(type) {
    if (type === "integer" || type === "float" || type === "double") {
        return "0";
    }
    if (type === "boolean") return "false";
    if (type === "string") return '""';
    if (type.startsWith("array:")) return "[]";
    // date, blob, stream, widget, json, event, any, enum:*, struct:*, object:*
    return "null";
}

export function addVariable(
    project,
    { name, type = "string", defaultValue, description, persistent }
) {
    if (!isValidVariableType(type)) {
        throw new Error(
            `invalid variable type: "${type}". Use a basic type ` +
                `(${[...BASIC_TYPES].join(", ")}) or enum:Name / struct:Name / ` +
                `object:Name / array:T.`
        );
    }
    project.variables = project.variables || {
        globalVariables: [],
        structures: [],
        enums: []
    };
    project.variables.globalVariables = project.variables.globalVariables || [];
    if (project.variables.globalVariables.find(v => v.name === name)) {
        throw new Error(`variable already exists: ${name}`);
    }
    const variable = {
        name,
        type,
        defaultValue:
            defaultValue !== undefined ? defaultValue : defaultForType(type)
    };
    if (description) variable.description = description;
    if (persistent) variable.persistent = true;
    project.variables.globalVariables.push(variable);
    return variable;
}

export function listVariables(project) {
    return ((project.variables && project.variables.globalVariables) || []).map(
        v => ({ name: v.name, type: v.type, defaultValue: v.defaultValue })
    );
}

// Bind a widget's data input to an expression (a bare name references a
// variable; quoted text is a string literal; numbers/booleans are literals).
export function bindWidget(project, { page, objID, expression }) {
    const p = findPage(project, page);
    const c = findComponent(p, objID);
    c.data = expression;
    return c;
}

// ---- flow: event handlers + connections -----------------------------------

export function addEventHandler(
    project,
    { page, objID, eventName = "CLICKED", handlerType = "flow", action }
) {
    if (handlerType === "action" && !action) {
        throw new Error(
            'handlerType "action" requires an `action` name to invoke'
        );
    }
    const p = findPage(project, page);
    const c = findComponent(p, objID);
    c.eventHandlers = c.eventHandlers || [];
    const handler = { eventName, handlerType };
    if (handlerType === "action") handler.action = action;
    c.eventHandlers.push(handler);
    return handler;
}

function sameLine(a, source, output, target, input) {
    return (
        a.source === source &&
        a.output === output &&
        a.target === target &&
        a.input === input
    );
}

export function connect(project, { page, source, output, target, input }) {
    const p = findPage(project, page);
    p.connectionLines = p.connectionLines || [];
    const ids = new Set((p.components || []).map(c => c.objID));
    if (!ids.has(source)) {
        throw new Error(`connection source component not found: ${source}`);
    }
    if (!ids.has(target)) {
        throw new Error(`connection target component not found: ${target}`);
    }
    // Idempotent: don't create duplicate identical lines.
    const existing = p.connectionLines.find(cl =>
        sameLine(cl, source, output, target, input)
    );
    if (existing) return existing;
    const line = { source, output, target, input, disabled: false };
    p.connectionLines.push(line);
    return line;
}

// Remove a connection line; returns the number removed (0 if none matched).
export function disconnect(project, { page, source, output, target, input }) {
    const p = findPage(project, page);
    const before = (p.connectionLines || []).length;
    p.connectionLines = (p.connectionLines || []).filter(
        cl => !sameLine(cl, source, output, target, input)
    );
    return before - p.connectionLines.length;
}

export function listConnections(project, { page }) {
    const p = findPage(project, page);
    return (p.connectionLines || []).map(cl => ({
        source: cl.source,
        output: cl.output,
        target: cl.target,
        input: cl.input
    }));
}

// ---- batch ----------------------------------------------------------------

// Top-level arg fields in which "$alias" references are substituted.
const REF_FIELDS = ["objID", "source", "target"];
const MAX_BATCH_OPS = 200;
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Does `v` look like an alias reference ("$name")?
function isRef(v) {
    return typeof v === "string" && v.startsWith("$");
}

/**
 * Replace "$alias" strings in the objID / source / target fields of `args`
 * (top level only) with the objID recorded in `refs`. Returns a shallow copy;
 * `args` is not mutated.
 * keep in sync with extension/live-ops.js resolveRefs
 * @param {object} args
 * @param {Record<string,string>} refs alias -> objID
 * @throws if a reference names an undefined alias
 */
export function resolveRefs(args, refs) {
    const out = { ...args };
    for (const f of REF_FIELDS) {
        const v = out[f];
        if (!isRef(v)) continue;
        const alias = v.slice(1);
        if (!Object.prototype.hasOwnProperty.call(refs || {}, alias)) {
            throw new Error(`undefined alias: ${v}`);
        }
        out[f] = refs[alias];
    }
    return out;
}

// MCP tool name -> { run(project, args) => result, creates } using the same
// functions (and result shapes) the file backend returns per tool.
const BATCH_TOOLS = {
    add_page: {
        run: (p, a) => ({ added: addPage(p, a).name })
    },
    add_widget: {
        creates: true,
        run: (p, a) => ({ objID: addWidget(p, a) })
    },
    add_action_component: {
        creates: true,
        run: (p, a) => ({ objID: addActionComponent(p, a) })
    },
    update_widget: {
        run: (p, a) => {
            updateWidget(p, a);
            return { updated: a.objID };
        }
    },
    delete_widget: {
        run: (p, a) => {
            deleteWidget(p, a);
            return { deleted: a.objID };
        }
    },
    add_variable: {
        run: (p, a) => {
            const v = addVariable(p, a);
            return { added: v.name, type: v.type, defaultValue: v.defaultValue };
        }
    },
    bind_widget: {
        run: (p, a) => {
            bindWidget(p, a);
            return { bound: a.objID, data: a.expression };
        }
    },
    add_event_handler: {
        run: (p, a) => ({ widget: a.objID, ...addEventHandler(p, a) })
    },
    connect: {
        run: (p, a) => ({
            connected: `${a.source}.${a.output} -> ${a.target}.${a.input}`,
            line: connect(p, a)
        })
    },
    disconnect: {
        run: (p, a) => ({ removed: disconnect(p, a) })
    }
};

/** Tool names accepted by applyBatch. */
export const BATCH_TOOL_NAMES = Object.keys(BATCH_TOOLS);

// Upfront validation; throws before anything is applied.
function validateBatch(ops) {
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > MAX_BATCH_OPS) {
        throw new Error(
            `batch needs 1-${MAX_BATCH_OPS} ops (got ${
                Array.isArray(ops) ? ops.length : typeof ops
            }); nothing applied`
        );
    }
    const defined = new Set();
    ops.forEach((op, i) => {
        const k = i + 1;
        const bad = msg => {
            throw new Error(
                `batch op #${k} (${op && op.tool}) invalid: ${msg}; nothing applied`
            );
        };
        if (!op || typeof op !== "object") bad("op must be an object");
        const def = BATCH_TOOLS[op.tool];
        if (!def) {
            bad(`unknown tool (allowed: ${BATCH_TOOL_NAMES.join(", ")})`);
        }
        const args = op.args === undefined ? {} : op.args;
        if (!args || typeof args !== "object" || Array.isArray(args)) {
            bad("args must be an object");
        }
        try {
            assertNoReservedProps(args.props);
        } catch (e) {
            bad(e.message);
        }
        // References must name an alias defined by an EARLIER op.
        for (const f of REF_FIELDS) {
            if (isRef(args[f]) && !defined.has(args[f].slice(1))) {
                bad(`${f} references undefined alias ${args[f]}`);
            }
        }
        if (op.as !== undefined) {
            if (!def.creates) {
                bad("`as` is only allowed on add_widget / add_action_component");
            }
            if (typeof op.as !== "string" || !ALIAS_RE.test(op.as)) {
                bad(`invalid alias "${op.as}" (use letters, digits, _)`);
            }
            if (defined.has(op.as)) bad(`duplicate alias "${op.as}"`);
            defined.add(op.as);
        }
    });
}

/**
 * Apply several authoring ops atomically to `project`.
 *
 * ops: [{ tool, args, as? }] with `tool` an MCP tool name (BATCH_TOOL_NAMES)
 * and `args` that tool's args minus `project`. Creating ops (add_widget,
 * add_action_component) may set `as: "name"`; later ops can then pass
 * "$name" in objID / source / target.
 *
 * All ops run against one structuredClone of the project. Only if every op
 * succeeds is the result copied back into `project` IN PLACE (so the caller
 * can save once); on any failure `project` is left untouched and an Error
 * `batch op #k (<tool>) failed: <msg>; nothing applied` (k 1-based) is thrown.
 * Upfront validation errors (1-200 ops, unknown tool, duplicate/undefined/
 * forward alias, reserved props) are thrown before anything runs.
 *
 * @param {Project} project mutated only on full success
 * @param {{tool:string,args?:object,as?:string}[]} ops
 * @returns {{applied:number,
 *            results:{index:number,tool:string,as?:string}[],
 *            refs:Record<string,string>}}
 *   results[i] = { index (1-based), tool, as?, ...the per-tool result the
 *   file backend returns, e.g. { objID } / { updated } / { connected, line } };
 *   refs maps alias -> resulting objID.
 */
export function applyBatch(project, ops) {
    validateBatch(ops);
    const work = structuredClone(project);
    const refs = {};
    const results = [];
    ops.forEach((op, i) => {
        const k = i + 1;
        try {
            const args = structuredClone(resolveRefs(op.args || {}, refs));
            const def = BATCH_TOOLS[op.tool];
            const result = def.run(work, args);
            const entry = { index: k, tool: op.tool };
            if (op.as !== undefined) {
                entry.as = op.as;
                refs[op.as] = result.objID;
            }
            results.push({ ...entry, ...result });
        } catch (e) {
            throw new Error(
                `batch op #${k} (${op.tool}) failed: ${e.message}; nothing applied`
            );
        }
    });
    // Success: replace contents of the caller's object in place.
    for (const key of Object.keys(project)) delete project[key];
    Object.assign(project, work);
    return { applied: results.length, results, refs };
}

// ---- widget catalog (schema) ----------------------------------------------

export function loadSchema(schemaPath) {
    return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

export function listComponentTypes(schema, kind = "all") {
    const widgets = (schema.widgets || []).map(w => ({
        type: w.type,
        kind: "widget"
    }));
    const actions = (schema.actionComponents || []).map(a => ({
        type: a.type,
        kind: "actionComponent"
    }));
    if (kind === "widget") return widgets;
    if (kind === "actionComponent") return actions;
    return [...widgets, ...actions];
}

export function getComponentSchema(schema, type) {
    const all = [
        ...(schema.widgets || []),
        ...(schema.actionComponents || [])
    ];
    const found = all.find(c => c.type === type);
    if (!found) throw new Error(`unknown component type: ${type}`);
    return {
        type: found.type,
        category: found.category,
        flowComponentId: found.flowComponentId,
        properties: (found.properties || [])
            .filter(p => p.serialized !== false)
            .map(p => ({
                name: p.name,
                eezType: p.eezType,
                jsonType: p.jsonType,
                flowProperty: p.flowProperty,
                expressionType: p.expressionType,
                referencedObjectCollectionPath:
                    p.referencedObjectCollectionPath,
                enum: p.enum,
                defaultValue: p.defaultValue
            }))
    };
}

// Validate a component type against the schema.
// @returns {{ok:false,error:string}|{ok:true,unknownProps:string[]}}
export function validateComponent(schema, type, props) {
    const all = [
        ...(schema.widgets || []),
        ...(schema.actionComponents || [])
    ];
    const found = all.find(c => c.type === type);
    if (!found) return { ok: false, error: `unknown component type: ${type}` };
    const known = new Set((found.properties || []).map(p => p.name));
    const unknownProps = Object.keys(props || {}).filter(k => !known.has(k));
    return { ok: true, unknownProps };
}
