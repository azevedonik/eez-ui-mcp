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

function assertNoReservedProps(props) {
    if (!props) return;
    const offending = RESERVED_PROPS.filter(k => k in props);
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
