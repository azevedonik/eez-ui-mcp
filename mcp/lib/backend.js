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

// --- live detection (short TTL cache so we don't ping on every call) --------

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

// --- local (file) helpers --------------------------------------------------

function editLocal(projectPath, fn) {
    const project = P.load(projectPath);
    const result = fn(project);
    P.save(projectPath, project);
    return result;
}

// Route an authoring/read verb: bridge when live (falling back on transport
// failure to the pure-JSON file path), else the file path. Returns
// { via:"live-editor"|"file", ...result }.
async function route(projectPath, opName, args, localFn) {
    if (await isLive()) {
        try {
            const result = await bridge.op(opName, { project: projectPath, ...args });
            return { via: "live-editor", ...result };
        } catch (e) {
            if (e && e.opError) throw e; // real editor error — surface it
            invalidateLive(); // transport failure — app closed mid-session
        }
    }
    return { via: "file", ...localFn() };
}

// Route a verb that REQUIRES the running editor (render/build/validate/checks).
async function routeLive(projectPath, opName, args, timeoutMs) {
    if (!(await isLive())) {
        throw new Error(`"${opName}" ${NEEDS_APP}`);
    }
    const result = await bridge.op(
        opName,
        { project: projectPath, ...args },
        timeoutMs
    );
    return { via: "live-editor", ...result };
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
            await bridge.op("reloadProject", { project: projectPath });
        } catch {
            /* best effort */
        }
    }
    return { created: projectPath };
}

export async function openInEditor(projectPath) {
    if (await isLive()) {
        try {
            await bridge.op("reloadProject", { project: projectPath });
            return true;
        } catch (e) {
            if (e && e.opError) throw e;
            invalidateLive();
        }
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
    return route(projectPath, "addPage", a, () => {
        const pg = editLocal(projectPath, proj => P.addPage(proj, a));
        return { added: pg.name };
    });
}

export function listPages(projectPath) {
    return route(projectPath, "listPages", {}, () => ({
        pages: P.listPages(P.load(projectPath))
    }));
}

// --- widgets ---------------------------------------------------------------

export function addWidget(projectPath, a) {
    return route(projectPath, "addWidget", a, () => ({
        objID: editLocal(projectPath, proj => P.addWidget(proj, a))
    }));
}

export function addActionComponent(projectPath, a) {
    return route(projectPath, "addActionComponent", a, () => ({
        objID: editLocal(projectPath, proj => P.addActionComponent(proj, a))
    }));
}

export function updateWidget(projectPath, a) {
    return route(projectPath, "updateWidget", a, () => {
        editLocal(projectPath, proj => P.updateWidget(proj, a));
        return { updated: a.objID };
    });
}

export function deleteWidget(projectPath, a) {
    return route(projectPath, "deleteWidget", a, () => {
        editLocal(projectPath, proj => P.deleteWidget(proj, a));
        return { deleted: a.objID };
    });
}

export function listWidgets(projectPath, a) {
    return route(projectPath, "listWidgets", a, () => ({
        widgets: P.listWidgets(P.load(projectPath), a)
    }));
}

// --- variables + binding ---------------------------------------------------

export function addVariable(projectPath, a) {
    return route(projectPath, "addVariable", a, () => {
        const v = editLocal(projectPath, proj => P.addVariable(proj, a));
        return { added: v.name, type: v.type, defaultValue: v.defaultValue };
    });
}

export function listVariables(projectPath) {
    return route(projectPath, "listVariables", {}, () => ({
        variables: P.listVariables(P.load(projectPath))
    }));
}

export function bindWidget(projectPath, a) {
    return route(projectPath, "bindWidget", a, () => {
        editLocal(projectPath, proj => P.bindWidget(proj, a));
        return { bound: a.objID, data: a.expression };
    });
}

// --- flow ------------------------------------------------------------------

export function addEventHandler(projectPath, a) {
    return route(projectPath, "addEventHandler", a, () => {
        const eh = editLocal(projectPath, proj => P.addEventHandler(proj, a));
        return { widget: a.objID, ...eh };
    });
}

export function connect(projectPath, a) {
    return route(projectPath, "connect", a, () => {
        const line = editLocal(projectPath, proj => P.connect(proj, a));
        return { connected: `${a.source}.${a.output} -> ${a.target}.${a.input}`, line };
    });
}

export function disconnect(projectPath, a) {
    return route(projectPath, "disconnect", a, () => ({
        removed: editLocal(projectPath, proj => P.disconnect(proj, a))
    }));
}

export function listConnections(projectPath, a) {
    return route(projectPath, "listConnections", a, () => ({
        connections: P.listConnections(P.load(projectPath), a)
    }));
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
    if (await isLive()) {
        try {
            await bridge.op("save", { project: projectPath });
            return { via: "live-editor", saved: projectPath };
        } catch (e) {
            if (e && e.opError) throw e;
            invalidateLive();
        }
    }
    return { via: "file", saved: projectPath };
}
