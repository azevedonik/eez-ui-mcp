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

const server = new McpServer({ name: "eez-ui", version: "0.2.0" });

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
        return text({ ...r, active: true, live: !!(await backend.isLive()) });
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
        return text({
            active: p,
            projectType: type || "dashboard",
            via: openedLive ? "live-editor" : "file"
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
        inputSchema: {
            project: z.string().optional(),
            name: z.string(),
            width: z.number().optional(),
            height: z.number().optional()
        }
    },
    handler(async ({ project, name, width, height }) => {
        const p = resolveProject(project);
        return text(await backend.addPage(p, { name, width, height }));
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
            "Add a widget to a page. `data` is an expression: a bare name binds to a variable, quoted text is a literal. Returns the new widget objID.",
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            type: z.string().describe('e.g. "TextDashboardWidget"'),
            left: z.number(),
            top: z.number(),
            width: z.number(),
            height: z.number(),
            data: z.string().optional(),
            props: z.record(z.any()).optional()
        }
    },
    handler(async ({ project, page, type, left, top, width, height, data, props }) => {
        const p = resolveProject(project);
        const check = P.validateComponent(await getSchema(), type, props || {});
        if (!check.ok) return fail(check.error);
        const r = await backend.addWidget(p, {
            page,
            type,
            left,
            top,
            width,
            height,
            data,
            props: props || {}
        });
        const warn =
            check.unknownProps && check.unknownProps.length
                ? { warning: `unknown props: ${check.unknownProps.join(", ")}` }
                : {};
        return text({ ...r, ...warn });
    })
);

server.registerTool(
    "update_widget",
    {
        description: "Update properties of a widget/component by objID.",
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            objID: z.string(),
            props: z.record(z.any())
        }
    },
    handler(async ({ project, page, objID, props }) => {
        const p = resolveProject(project);
        return text(await backend.updateWidget(p, { page, objID, props }));
    })
);

server.registerTool(
    "delete_widget",
    {
        description:
            "Delete a widget/component by objID (also removes its connection lines).",
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            objID: z.string()
        }
    },
    handler(async ({ project, page, objID }) => {
        const p = resolveProject(project);
        return text(await backend.deleteWidget(p, { page, objID }));
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
        inputSchema: {
            project: z.string().optional(),
            name: z.string(),
            type: z.string().optional(),
            defaultValue: z.string().optional(),
            description: z.string().optional(),
            persistent: z.boolean().optional()
        }
    },
    handler(async ({ project, name, type, defaultValue, description, persistent }) => {
        const p = resolveProject(project);
        return text(
            await backend.addVariable(p, {
                name,
                type,
                defaultValue,
                description,
                persistent
            })
        );
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
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            objID: z.string(),
            expression: z.string()
        }
    },
    handler(async ({ project, page, objID, expression }) => {
        const p = resolveProject(project);
        return text(await backend.bindWidget(p, { page, objID, expression }));
    })
);

// ---- flow: action components, event handlers, connections -----------------

server.registerTool(
    "add_action_component",
    {
        description:
            'Add a flow action component (e.g. "SetVariableActionComponent" with props {entries:[{variable,value}]}). Returns its objID.',
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            type: z.string(),
            left: z.number(),
            top: z.number(),
            width: z.number().optional(),
            height: z.number().optional(),
            props: z.record(z.any()).optional()
        }
    },
    handler(async ({ project, page, type, left, top, width, height, props }) => {
        const p = resolveProject(project);
        const check = P.validateComponent(await getSchema(), type, props || {});
        if (!check.ok) return fail(check.error);
        return text(
            await backend.addActionComponent(p, {
                page,
                type,
                left,
                top,
                width,
                height,
                props: props || {}
            })
        );
    })
);

server.registerTool(
    "add_event_handler",
    {
        description:
            'Add an event handler to a widget. handlerType "flow" creates an output pin named eventName (e.g. "CLICKED") to wire with connect(); "action" invokes a named action directly.',
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            objID: z.string(),
            eventName: z.string().optional(),
            handlerType: z.enum(["flow", "action"]).optional(),
            action: z.string().optional()
        }
    },
    handler(async ({ project, page, objID, eventName, handlerType, action }) => {
        const p = resolveProject(project);
        return text(
            await backend.addEventHandler(p, {
                page,
                objID,
                eventName,
                handlerType,
                action
            })
        );
    })
);

server.registerTool(
    "connect",
    {
        description:
            'Add a flow connection line from a source component output pin to a target component input pin. Pins: widget event outputs (e.g. "CLICKED"), action sequence pins "@seqout"/"@seqin", or named data pins.',
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            source: z.string().describe("source component objID"),
            output: z.string(),
            target: z.string().describe("target component objID"),
            input: z.string()
        }
    },
    handler(async ({ project, page, source, output, target, input }) => {
        const p = resolveProject(project);
        return text(
            await backend.connect(p, { page, source, output, target, input })
        );
    })
);

server.registerTool(
    "disconnect",
    {
        description:
            "Remove a flow connection line matching source/output/target/input. Returns how many were removed.",
        inputSchema: {
            project: z.string().optional(),
            page: z.string(),
            source: z.string(),
            output: z.string(),
            target: z.string(),
            input: z.string()
        }
    },
    handler(async ({ project, page, source, output, target, input }) => {
        const p = resolveProject(project);
        return text(
            await backend.disconnect(p, { page, source, output, target, input })
        );
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
