// Transport selector for the eez-ui MCP.
//
// Primary path (vibe-coding): when EEZ Studio is open with the eez-ui-bridge
// extension, edits are applied to the LIVE editor through the editor's own
// operations, so they appear in the user's window in real time and behave
// exactly as if clicked. Tool results are tagged "via":"live-editor".
//
// Authoring also has a no-app fallback: it edits the documented `.eez-project`
// JSON directly (lib/project.js, pure data — no EEZ Studio, no build). Operations
// that fundamentally need the running editor (render/build/validate/get_checks)
// require a live app and say so clearly when one isn't reachable.
//
// This module has NO dependency on a built EEZ Studio checkout: the widget
// catalog and the new-project template are shipped with the package.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import * as P from "./project.js";
import * as bridge from "./bridge-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");

// Shipped artifacts (committed; regenerate on an EEZ Studio version bump).
export const SCHEMA_PATH =
    process.env.EEZ_WIDGET_SCHEMA ||
    path.join(PKG_ROOT, "dashboard-widgets.schema.json");
const TEMPLATE_PATH = path.join(PKG_ROOT, "dashboard-template.eez-project");

// --- live detection --------------------------------------------------------
//
// Authoring/read verbs do NOT ping first: they send the op straight to the
// bridge and fall back to the file path only when the request was certainly
// never delivered (no/dead discovery file, connection refused, connect
// timeout — see bridge-client.js). isLive() (short TTL cache) is kept for
// status reporting.

let liveCache = { ts: 0, disc: null };
const LIVE_TTL_MS = 1500;

export async function isLive() {
    const now = Date.now();
    if (now - liveCache.ts < LIVE_TTL_MS) return liveCache.disc;
    const disc = await bridge.ping();
    liveCache = { ts: now, disc };
    return disc;
}

function invalidateLive() {
    liveCache = { ts: 0, disc: null };
}

const NEEDS_APP =
    "needs EEZ Studio running with the eez-ui-bridge extension installed";

// Oldest eez-ui-bridge this MCP is written against (batch op, version fields
// in /ping). Kept as a constant: the MCP never reads ../extension at runtime.
export const MIN_BRIDGE_VERSION = "0.2.0";

const UPDATE_BRIDGE =
    "update the eez-ui-bridge extension: run `node extension/install.mjs` " +
    "from the eez-ui-mcp repo, then restart EEZ Studio";

// Numeric compare of "x.y.z" versions (pre-release/build suffixes ignored).
// Returns <0, 0, >0.
export function compareVersions(a, b) {
    const parse = v =>
        String(v).split(/[-+]/)[0].split(".").map(n => parseInt(n, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
}

// Bridge/Studio versions as reported by /ping, plus a warning when the
// installed bridge is older than MIN_BRIDGE_VERSION. null if not reachable.
export async function bridgeStatus() {
    const info = await bridge.pingInfo();
    if (!info) return null;
    const bridgeVersion = info.bridgeVersion || info.version || null;
    const out = { studioVersion: info.studioVersion || null, bridgeVersion };
    if (!bridgeVersion || compareVersions(bridgeVersion, MIN_BRIDGE_VERSION) < 0) {
        out.warning =
            `eez-ui-bridge ${bridgeVersion || "(unknown version)"} is older than ` +
            `${MIN_BRIDGE_VERSION}, which this MCP requires (e.g. for batch); ${UPDATE_BRIDGE}`;
    }
    return out;
}

// May the caller fall back to the file path after this bridge error? Only
// when the request never reached the editor.
function notDelivered(e) {
    return !!(e && e.notDelivered);
}

// --- local (file) helpers --------------------------------------------------

function editLocal(projectPath, fn) {
    const project = P.load(projectPath);
    const result = fn(project);
    P.save(projectPath, project);
    return result;
}

// Route an authoring/read verb: straight to the bridge; on a not-delivered
// error (no live editor) use the pure-JSON file path. Every other error (op
// error, ambiguous timeout/reset, non-200) propagates — falling back then could
// apply the edit twice or edit the file under an open editor. Returns
// { via:"live-editor"|"file", ...result }.
async function route(projectPath, opName, args, localFn) {
    try {
        const result = await bridge.op(opName, { project: projectPath, ...args });
        return { via: "live-editor", ...result };
    } catch (e) {
        if (!notDelivered(e)) throw e;
        invalidateLive(); // no editor (or it closed mid-session)
    }
    return { via: "file", ...localFn() };
}

// Route a verb that REQUIRES the running editor (render/build/validate/checks).
async function routeLive(projectPath, opName, args, timeoutMs) {
    try {
        const result = await bridge.op(
            opName,
            { project: projectPath, ...args },
            timeoutMs
        );
        return { via: "live-editor", ...result };
    } catch (e) {
        if (!notDelivered(e)) throw e;
        invalidateLive();
        throw new Error(`"${opName}" ${NEEDS_APP}`);
    }
}

// --- project lifecycle -----------------------------------------------------

export async function createDashboard(projectPath, { displayWidth, displayHeight } = {}) {
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.copyFileSync(TEMPLATE_PATH, projectPath); // valid empty Dashboard shell
    if (displayWidth || displayHeight) {
        editLocal(projectPath, project => {
            if (displayWidth) project.settings.general.displayWidth = displayWidth;
            if (displayHeight) project.settings.general.displayHeight = displayHeight;
        });
    }
    // If a live app is running, open it so the user sees it (reload in case a
    // stale tab for this path is already open).
    if (await isLive()) {
        try {
            await bridge.op("reloadProject", { project: projectPath }, OPEN_TIMEOUT_MS);
        } catch {
            /* best effort */
        }
    }
    return { created: projectPath };
}

// Opening a project can take the bridge's resolveStore up to 3 x 20 s (tab,
// store, project); leave headroom so a slow open isn't reported as ambiguous.
const OPEN_TIMEOUT_MS = 90000;

export async function openInEditor(projectPath) {
    try {
        await bridge.op("reloadProject", { project: projectPath }, OPEN_TIMEOUT_MS);
        return true;
    } catch (e) {
        if (!notDelivered(e)) throw e;
        invalidateLive();
    }
    return false;
}

// --- widget catalog (shipped, no app needed) -------------------------------

let schemaCache = null;
export function schema() {
    if (!schemaCache) schemaCache = P.loadSchema(SCHEMA_PATH);
    return schemaCache;
}

// --- pages -----------------------------------------------------------------

export function addPage(projectPath, a) {
    return route(projectPath, "addPage", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "add_page", a))
    );
}

export function listPages(projectPath) {
    return route(projectPath, "listPages", {}, () => ({
        pages: P.listPages(P.load(projectPath))
    }));
}

// --- widgets ---------------------------------------------------------------

export function addWidget(projectPath, a) {
    return route(projectPath, "addWidget", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "add_widget", a))
    );
}

export function addActionComponent(projectPath, a) {
    return route(projectPath, "addActionComponent", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "add_action_component", a))
    );
}

export function updateWidget(projectPath, a) {
    return route(projectPath, "updateWidget", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "update_widget", a))
    );
}

export function deleteWidget(projectPath, a) {
    return route(projectPath, "deleteWidget", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "delete_widget", a))
    );
}

export function listWidgets(projectPath, a) {
    return route(projectPath, "listWidgets", a, () => ({
        widgets: P.listWidgets(P.load(projectPath), a)
    }));
}

// --- variables + binding ---------------------------------------------------

export function addVariable(projectPath, a) {
    return route(projectPath, "addVariable", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "add_variable", a))
    );
}

export function listVariables(projectPath) {
    return route(projectPath, "listVariables", {}, () => ({
        variables: P.listVariables(P.load(projectPath))
    }));
}

export function bindWidget(projectPath, a) {
    return route(projectPath, "bindWidget", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "bind_widget", a))
    );
}

// --- flow ------------------------------------------------------------------

export function addEventHandler(projectPath, a) {
    return route(projectPath, "addEventHandler", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "add_event_handler", a))
    );
}

export function connect(projectPath, a) {
    return route(projectPath, "connect", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "connect", a))
    );
}

export function disconnect(projectPath, a) {
    return route(projectPath, "disconnect", a, () =>
        editLocal(projectPath, proj => P.runTool(proj, "disconnect", a))
    );
}

export function listConnections(projectPath, a) {
    return route(projectPath, "listConnections", a, () => ({
        connections: P.listConnections(P.load(projectPath), a)
    }));
}

// --- batch -----------------------------------------------------------------

// MCP tool name -> bridge op name. Each tool's args are passed to the bridge
// unchanged, exactly like the single-op functions above do.
const TOOL_TO_OP = {
    add_page: "addPage",
    add_widget: "addWidget",
    add_action_component: "addActionComponent",
    update_widget: "updateWidget",
    delete_widget: "deleteWidget",
    add_variable: "addVariable",
    bind_widget: "bindWidget",
    add_event_handler: "addEventHandler",
    connect: "connect",
    disconnect: "disconnect"
};
const OP_TO_TOOL = Object.fromEntries(
    Object.entries(TOOL_TO_OP).map(([tool, op]) => [op, tool])
);

// A live batch failure names bridge ops; report the MCP tool name so live
// matches file mode ("batch op #k (delete_widget) ..."). bridge.op() has
// already reduced the error to its message line.
function cleanBatchError(e) {
    const msg = String(e.message || "").replace(
        /^(batch op #\d+ )\((\w+)\)/,
        (m, pre, op) => `${pre}(${OP_TO_TOOL[op] || op})`
    );
    const out = new Error(msg);
    out.opError = true;
    return out;
}

// Apply ops [{ tool, args, as? }] all-or-nothing (live: one bridge request,
// one undo step; file: one load + one save, only on full success). Returns
// { via, applied, results:[{ index, tool, as?, ...opResult }], refs }.
export async function batch(projectPath, ops) {
    const liveOps = (ops || []).map((o, i) => {
        const op = o && TOOL_TO_OP[o.tool];
        if (!op) {
            throw new Error(
                `batch op #${i + 1} (${o && o.tool}) invalid: unknown tool; nothing applied`
            );
        }
        return { op, args: o.args || {}, ...(o.as !== undefined ? { as: o.as } : {}) };
    });
    try {
        const r = await bridge.op(
            "batch",
            { project: projectPath, ops: liveOps },
            120000
        );
        return {
            via: "live-editor",
            applied: r.applied,
            results: (r.results || []).map(({ op, index, ...rest }) => ({
                index,
                tool: OP_TO_TOOL[op] || op,
                ...rest
            })),
            refs: r.refs || {}
        };
    } catch (e) {
        if (e && e.opError && /unknown op: batch/.test(e.message)) {
            throw new Error(
                `the installed eez-ui-bridge does not support batch (needs >= ${MIN_BRIDGE_VERSION}); ${UPDATE_BRIDGE}. Nothing applied.`
            );
        }
        if (e && e.opError) throw cleanBatchError(e);
        if (!notDelivered(e)) throw e;
        invalidateLive();
    }
    const project = P.load(projectPath);
    const result = P.applyBatch(project, ops); // throws -> nothing saved
    P.save(projectPath, project);
    return { via: "file", ...result };
}

// --- live-only: visualize + verify -----------------------------------------

export async function render(projectPath, { page, mode } = {}) {
    const theMode = mode || "design";
    const r = await routeLive(projectPath, "render", { page, mode: theMode }, 90000);
    return { via: r.via, pngBase64: r.png, mode: r.mode || theMode };
}

export function build(projectPath) {
    return routeLive(projectPath, "build", {}, 180000);
}

export function validate(projectPath) {
    return routeLive(projectPath, "validate", {}, 60000);
}

export function getChecks(projectPath) {
    return routeLive(projectPath, "getChecks", {}, 60000);
}

export async function save(projectPath) {
    try {
        await bridge.op("save", { project: projectPath });
        return { via: "live-editor", saved: projectPath };
    } catch (e) {
        if (!notDelivered(e)) throw e;
        invalidateLive();
    }
    return { via: "file", saved: projectPath }; // file edits are already on disk
}
