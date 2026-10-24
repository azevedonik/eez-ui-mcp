#!/usr/bin/env node
// MCP server for authoring EEZ Studio Dashboard UI with Claude Code.
//
// Two execution modes, chosen automatically per call (see lib/backend.js):
//   - LIVE: if EEZ Studio is open with the eez-ui-bridge extension, edits are
//     applied to the running editor and appear in the user's window in real
//     time (vibe-coding). Tool results are tagged `"via":"live-editor"`.
//   - FILE: otherwise, the .eez-project JSON is edited on disk and the headless
//     EEZ Studio CLI handles render/build/validate. Results are `"via":"file"`.
//
// Tools cover: project/page/widget authoring, variable mapping + data binding,
// EEZ Flow (action components, event handlers, connections), and visualization
// (render design/run to PNG) + build/validate verification.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as P from "./lib/project.js";
import * as backend from "./lib/backend.js";

let activeProject = null; // last created/opened project path

function resolveProject(arg) {
    const p = arg || activeProject;
    if (!p) {
        throw new Error(
            "No project selected. Pass `project` or call create_dashboard_project / open_project first."
        );
    }
    return p;
}

function text(obj) {
    return {
        content: [
            {
                type: "text",
                text:
                    typeof obj === "string"
                        ? obj
                        : JSON.stringify(obj, null, 2)
            }
        ]
    };
}

function fail(message) {
    return { content: [{ type: "text", text: "ERROR: " + message }], isError: true };
}

// Serialize all tool invocations through a single queue. Authoring is one
// edit-at-a-time (live editor mutation or load->mutate->save on a file), and the
// MCP SDK does not serialize handlers; running them strictly one-at-a-time
// removes any torn-read / lost-update / interleaved-edit hazard.
let opTail = Promise.resolve();
function enqueue(task) {
    const result = opTail.then(task, task);
    opTail = result.then(
        () => {},
        () => {}
    );
    return result;
}

// Wrap a handler so it runs serialized and thrown errors become tool errors
// instead of crashing the server.
function handler(fn) {
    return args =>
        enqueue(async () => {
            try {
                return await fn(args);
            } catch (e) {
                return fail(e && e.message ? e.message : String(e));
            }
        });
}

// The widget catalog is a shipped, version-specific artifact (committed with the
// package); no running app or build is needed to read it.
function getSchema() {
    return backend.schema();
}

// ---- shared input shapes for the mutating tools ---------------------------
//
// Raw zod shapes WITHOUT `project`. Each single tool registers
// { project, ...TOOL_SHAPES[name] }; `batch` validates every op's args against
// z.object(TOOL_SHAPES[tool]).strict() (the batch targets one project).
const TOOL_SHAPES = {
    add_page: {
        name: z.string(),
        width: z.number().optional(),
        height: z.number().optional()
    },
    add_widget: {
        page: z.string(),
        type: z.string().describe('e.g. "TextDashboardWidget"'),
        left: z.number(),
        top: z.number(),
        width: z.number(),
        height: z.number(),
        data: z.string().optional(),
        props: z.record(z.any()).optional()
    },
    update_widget: {
        page: z.string(),
        objID: z.string(),
        props: z.record(z.any())
    },
    delete_widget: {
        page: z.string(),
        objID: z.string()
    },
    add_variable: {
        name: z.string(),
        type: z.string().optional(),
        defaultValue: z.string().optional(),
        description: z.string().optional(),
        persistent: z.boolean().optional()
    },
    bind_widget: {
        page: z.string(),
        objID: z.string(),
        expression: z.string()
    },
    add_action_component: {
        page: z.string(),
        type: z.string(),
        left: z.number(),
        top: z.number(),
        width: z.number().optional(),
        height: z.number().optional(),
        props: z.record(z.any()).optional()
    },
    add_event_handler: {
        page: z.string(),
        objID: z.string(),
        eventName: z.string().optional(),
        handlerType: z.enum(["flow", "action"]).optional(),
        action: z.string().optional()
    },
    connect: {
        page: z.string(),
        source: z.string().describe("source component objID"),
        output: z.string(),
        target: z.string().describe("target component objID"),
        input: z.string()
    },
    disconnect: {
        page: z.string(),
        source: z.string(),
        output: z.string(),
        target: z.string(),
        input: z.string()
    }
};

for (const name of P.BATCH_TOOL_NAMES) {
    if (!TOOL_SHAPES[name]) throw new Error(`TOOL_SHAPES is missing "${name}"`);
}

// Input shape of a single mutating tool: optional project + the shared shape.
function toolShape(name) {
    return { project: z.string().optional(), ...TOOL_SHAPES[name] };
}

// Checks shared by the single tools and every batch op, run before anything is
// sent: reserved props (objID/type) and, for component-creating tools, the
// shipped component catalog. Returns { args, warning? } where args is what the
// backend receives; throws with a user-facing message.
async function prepare(tool, a) {
    switch (tool) {
        case "add_widget":
        case "add_action_component": {
            const props = a.props || {};
            P.assertNoReservedProps(props);
            const check = P.validateComponent(await getSchema(), a.type, props);
            if (!check.ok) throw new Error(check.error);
            const args = { ...a, props };
            const warning =
                tool === "add_widget" && check.unknownProps && check.unknownProps.length
                    ? `unknown props: ${check.unknownProps.join(", ")}`
                    : undefined;
            return { args, warning };
        }
        case "update_widget":
            P.assertNoReservedProps(a.props);
            return { args: a };
        default:
            return { args: a };
    }
}

// Strip `project` (handled by resolveProject) from a single tool's args.
function withoutProject({ project, ...rest }) {
    return rest;
}

function zodIssues(error) {
    return error.issues
        .map(i => `${i.path.length ? i.path.join(".") : "args"}: ${i.message}`)
        .join("; ");
}

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("./package.json");

const server = new McpServer({ name: "eez-ui", version: SERVER_VERSION });

// ---- project lifecycle ----------------------------------------------------

server.registerTool(
    "create_dashboard_project",
    {
        description:
            "Create a new EEZ Studio Dashboard project file (valid empty shell) and make it the active project. If EEZ Studio is running, it is opened there.",
        inputSchema: {
            path: z.string().describe("Absolute path for the .eez-project file"),
            displayWidth: z.number().optional(),
            displayHeight: z.number().optional()
        }
    },
    handler(async ({ path: p, displayWidth, displayHeight }) => {
        const r = await backend.createDashboard(p, { displayWidth, displayHeight });
        activeProject = p;
        const status = await backend.bridgeStatus(); // { studioVersion, bridgeVersion, warning? }
        return text({ ...r, active: true, live: !!status, ...(status || {}) });
    })
);

server.registerTool(
    "open_project",
    {
        description:
            "Set an existing .eez-project file as the active project (and open it in EEZ Studio if it is running).",
        inputSchema: { path: z.string() }
    },
    handler(async ({ path: p }) => {
        if (!fs.existsSync(p)) return fail(`not found: ${p}`);
        const project = P.load(p); // validate JSON parses
        const type =
            project &&
            project.settings &&
            project.settings.general &&
            project.settings.general.projectType;
        if (type && type !== "dashboard") {
            return fail(
                `not a Dashboard project (projectType="${type}"). ` +
                    `This MCP only supports dashboard projects.`
            );
        }
        activeProject = p;
        const openedLive = await backend.openInEditor(p);
        const status = openedLive ? await backend.bridgeStatus() : null;
        return text({
            active: p,
            projectType: type || "dashboard",
            via: openedLive ? "live-editor" : "file",
            ...(status || {})
        });
    })
);

// ---- widget catalog -------------------------------------------------------

server.registerTool(
    "list_widget_types",
    {
        description:
            "List available Dashboard component types (widgets and flow action components).",
        inputSchema: {
            kind: z.enum(["all", "widget", "actionComponent"]).optional()
        }
    },
    handler(async ({ kind }) =>
        text(P.listComponentTypes(await getSchema(), kind || "all"))
    )
);

server.registerTool(
    "get_widget_schema",
    {
        description:
            "Get the serializable properties of a component type (which props are flow inputs, references, enums, defaults).",
        inputSchema: { type: z.string() }
    },
    handler(async ({ type }) => text(P.getComponentSchema(await getSchema(), type)))
);

// ---- pages ----------------------------------------------------------------

server.registerTool(
    "add_page",
    {
        description: "Add a page (screen) to the project.",
        inputSchema: toolShape("add_page")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        return text(await backend.addPage(p, withoutProject(a)));
    })
);

server.registerTool(
    "list_pages",
    {
        description: "List pages in the project.",
        inputSchema: { project: z.string().optional() }
    },
    handler(async ({ project }) =>
        text(await backend.listPages(resolveProject(project)))
    )
);

// ---- widgets --------------------------------------------------------------

server.registerTool(
    "add_widget",
    {
        description:
            "Add a widget to a page. `data` is an expression: a bare name binds to a variable, quoted text is a literal. Returns the new widget objID. To build several widgets/flows at once, prefer `batch`.",
        inputSchema: toolShape("add_widget")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        const { args, warning } = await prepare("add_widget", withoutProject(a));
        const r = await backend.addWidget(p, args);
        return text(warning ? { ...r, warning } : r);
    })
);

server.registerTool(
    "update_widget",
    {
        description:
            "Update properties of a widget/component by objID (`objID` and `type` cannot be changed via props).",
        inputSchema: toolShape("update_widget")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        const { args } = await prepare("update_widget", withoutProject(a));
        return text(await backend.updateWidget(p, args));
    })
);

server.registerTool(
    "delete_widget",
    {
        description:
            "Delete a widget/component by objID (also removes its connection lines).",
        inputSchema: toolShape("delete_widget")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        return text(await backend.deleteWidget(p, withoutProject(a)));
    })
);

server.registerTool(
    "list_widgets",
    {
        description: "List widgets/components on a page with their objIDs.",
        inputSchema: { project: z.string().optional(), page: z.string() }
    },
    handler(async ({ project, page }) =>
        text(await backend.listWidgets(resolveProject(project), { page }))
    )
);

// ---- variables + binding --------------------------------------------------

server.registerTool(
    "add_variable",
    {
        description:
            "Add a global variable. type e.g. integer/float/double/boolean/string/json/any, or enum:Name / struct:Name / array:T. defaultValue is an expression string.",
        inputSchema: toolShape("add_variable")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        return text(await backend.addVariable(p, withoutProject(a)));
    })
);

server.registerTool(
    "list_variables",
    {
        description: "List global variables.",
        inputSchema: { project: z.string().optional() }
    },
    handler(async ({ project }) =>
        text(await backend.listVariables(resolveProject(project)))
    )
);

server.registerTool(
    "bind_widget",
    {
        description:
            'Bind a widget\'s data input to an expression (a bare name maps to a variable, e.g. "counter"; quoted text is a literal, e.g. "\\"hi\\"").',
        inputSchema: toolShape("bind_widget")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        return text(await backend.bindWidget(p, withoutProject(a)));
    })
);

// ---- flow: action components, event handlers, connections -----------------

server.registerTool(
    "add_action_component",
    {
        description:
            'Add a flow action component (e.g. "SetVariableActionComponent" with props {entries:[{variable,value}]}). Returns its objID.',
        inputSchema: toolShape("add_action_component")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        const { args } = await prepare("add_action_component", withoutProject(a));
        return text(await backend.addActionComponent(p, args));
    })
);

server.registerTool(
    "add_event_handler",
    {
        description:
            'Add an event handler to a widget. handlerType "flow" creates an output pin named eventName (e.g. "CLICKED") to wire with connect(); "action" invokes a named action directly.',
        inputSchema: toolShape("add_event_handler")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        return text(await backend.addEventHandler(p, withoutProject(a)));
    })
);

server.registerTool(
    "connect",
    {
        description:
            'Add a flow connection line from a source component output pin to a target component input pin. Pins: widget event outputs (e.g. "CLICKED"), action sequence pins "@seqout"/"@seqin", or named data pins.',
        inputSchema: toolShape("connect")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        return text(await backend.connect(p, withoutProject(a)));
    })
);

server.registerTool(
    "disconnect",
    {
        description:
            "Remove a flow connection line matching source/output/target/input. Returns how many were removed.",
        inputSchema: toolShape("disconnect")
    },
    handler(async a => {
        const p = resolveProject(a.project);
        return text(await backend.disconnect(p, withoutProject(a)));
    })
);

server.registerTool(
    "list_connections",
    {
        description: "List flow connection lines on a page.",
        inputSchema: { project: z.string().optional(), page: z.string() }
    },
    handler(async ({ project, page }) =>
        text(await backend.listConnections(resolveProject(project), { page }))
    )
);

// ---- batch ----------------------------------------------------------------

server.registerTool(
    "batch",
    {
        description:
            "Apply many authoring ops in ONE call, all-or-nothing. PREFER this over individual calls when building or changing a screen: far fewer tool calls, and live it is a single undo step in EEZ Studio. " +
            "ops: 1-200 entries run in order, each { tool, args, as? } where tool is one of " +
            P.BATCH_TOOL_NAMES.join(", ") +
            " and args are exactly that tool's arguments without `project`. " +
            'An add_widget / add_action_component op may set as:"btn"; a LATER op can then pass "$btn" as objID, source or target and it is replaced with the created objID (no other field is substituted). ' +
            "Every op is validated before anything is applied; any failure returns `batch op #k (tool) ...; nothing applied`. " +
            "Returns { via, applied, results:[{index, tool, as?, ...}], refs:{alias: objID} }.",
        inputSchema: {
            project: z.string().optional(),
            ops: z
                .array(
                    z.object({
                        tool: z.enum(P.BATCH_TOOL_NAMES),
                        args: z.record(z.any()),
                        as: z
                            .string()
                            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "alias must use letters, digits, _ and not start with a digit")
                            .optional()
                    })
                )
                .min(1)
                .max(200)
        }
    },
    handler(async ({ project, ops }) => {
        const p = resolveProject(project);
        const prepared = [];
        const warnings = [];
        for (let i = 0; i < ops.length; i++) {
            const { tool, args, as } = ops[i];
            const where = `batch op #${i + 1} (${tool})`;
            const parsed = z.object(TOOL_SHAPES[tool]).strict().safeParse(args);
            if (!parsed.success) {
                throw new Error(`${where} invalid: ${zodIssues(parsed.error)}; nothing applied`);
            }
            let prep;
            try {
                prep = await prepare(tool, parsed.data);
            } catch (e) {
                throw new Error(`${where} invalid: ${e.message}; nothing applied`);
            }
            if (prep.warning) warnings.push(`op #${i + 1}: ${prep.warning}`);
            prepared.push({ tool, args: prep.args, ...(as !== undefined ? { as } : {}) });
        }
        const r = await backend.batch(p, prepared);
        return text(warnings.length ? { ...r, warnings } : r);
    })
);

// ---- visualize + verify ---------------------------------------------------

server.registerTool(
    "render",
    {
        description:
            'Render a page to PNG and return the image. mode "design" shows the editor layout (incl. flow graph); mode "run" shows the live dashboard on the board. When EEZ Studio is open this captures the live window.',
        inputSchema: {
            project: z.string().optional(),
            page: z.string().optional(),
            mode: z.enum(["design", "run"]).optional()
        }
    },
    handler(async ({ project, page, mode }) => {
        const p = resolveProject(project);
        const r = await backend.render(p, { page, mode });
        return {
            content: [
                {
                    type: "text",
                    text: `rendered ${r.mode}${
                        page ? ` page "${page}"` : ""
                    } (via ${r.via})`
                },
                { type: "image", data: r.pngBase64, mimeType: "image/png" }
            ]
        };
    })
);

server.registerTool(
    "save",
    {
        description:
            "Persist the project to disk. In live mode this saves the running editor's project; otherwise it is a no-op (file edits are already saved). Call before build/validate after live edits.",
        inputSchema: { project: z.string().optional() }
    },
    handler(async ({ project }) => text(await backend.save(resolveProject(project))))
);

server.registerTool(
    "get_checks",
    {
        description:
            "Run EEZ Studio's semantic checks (the editor's \"Checks\" panel) and return diagnostics: {errors, warnings, total, checks:[{type:error|warning|info, message, location, objID}]}. Use this to find and fix invalid references (styles, variables, expressions) without a full build.",
        inputSchema: { project: z.string().optional() }
    },
    handler(async ({ project }) => text(await backend.getChecks(resolveProject(project))))
);

server.registerTool(
    "build",
    {
        description:
            "Build/compile the project (verifies it is valid). Flushes live edits to disk first. Returns build messages including any errors/warnings.",
        inputSchema: { project: z.string().optional() }
    },
    handler(async ({ project }) => text(await backend.build(resolveProject(project))))
);

server.registerTool(
    "validate",
    {
        description:
            "Validate the project by loading and re-serializing it through EEZ Studio. Flushes live edits to disk first. Reports load errors.",
        inputSchema: { project: z.string().optional() }
    },
    handler(async ({ project }) =>
        text(await backend.validate(resolveProject(project)))
    )
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("eez-ui MCP server running on stdio");
