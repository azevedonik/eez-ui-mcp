// Spawns the MCP server and drives it over stdio like a real client, to verify
// the protocol layer: tools are listed, calls work, render returns an image.
// Needs EEZ Studio running with the eez-ui-bridge extension (live pass); a
// second server is started with the bridge hidden to exercise file mode.
//   node test/mcp.js [outDir]
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
    StdioClientTransport,
    getDefaultEnvironment
} from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || path.join(os.tmpdir(), "eez-mcp-server-test");
fs.mkdirSync(outDir, { recursive: true });
const projectPath = path.join(outDir, "server-test.eez-project");

function summarize(result) {
    return (result.content || [])
        .map(c =>
            c.type === "image"
                ? `image(${c.mimeType}, ${c.data.length} b64 chars)`
                : `text(${(c.text || "").slice(0, 80).replace(/\n/g, " ")})`
        )
        .join(" | ");
}

function check(cond, message) {
    if (!cond) throw new Error("ASSERTION FAILED: " + message);
}

function json(r) {
    check(!r.isError, `tool error: ${r.content && r.content[0] && r.content[0].text}`);
    return JSON.parse(r.content[0].text);
}

// Start a server; `env` overrides are merged into the SDK's default env.
async function connect(env = {}) {
    const transport = new StdioClientTransport({
        command: process.execPath, // same node that runs this test
        args: [path.join(__dirname, "..", "server.js")],
        env: { ...getDefaultEnvironment(), ...env }
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
    const call = async (name, args) => {
        const r = await client.callTool({ name, arguments: args });
        console.log(`${name}: ${summarize(r)}${r.isError ? " [ERROR]" : ""}`);
        return r;
    };
    return { client, call };
}

// The 6-op batch: page, variable, text, button (as btn), action (as act),
// connect $btn -> $act. Asserts it applied and list_widgets shows the result.
async function batchScenario(call, file, expectVia) {
    json(await call("create_dashboard_project", { path: file }));
    const r = json(
        await call("batch", {
            ops: [
                { tool: "add_page", args: { name: "Batch" } },
                {
                    tool: "add_variable",
                    args: { name: "count", type: "integer", defaultValue: "0" }
                },
                {
                    tool: "add_widget",
                    args: {
                        page: "Batch",
                        type: "TextDashboardWidget",
                        left: 20,
                        top: 20,
                        width: 220,
                        height: 30,
                        data: "count"
                    }
                },
                {
                    tool: "add_widget",
                    as: "btn",
                    args: {
                        page: "Batch",
                        type: "ButtonDashboardWidget",
                        left: 20,
                        top: 70,
                        width: 160,
                        height: 44,
                        data: '"Go"'
                    }
                },
                {
                    tool: "add_action_component",
                    as: "act",
                    args: {
                        page: "Batch",
                        type: "SetVariableActionComponent",
                        left: 260,
                        top: 70,
                        props: { entries: [{ variable: "count", value: "count + 1" }] }
                    }
                },
                {
                    tool: "connect",
                    args: {
                        page: "Batch",
                        source: "$btn",
                        output: "CLICKED",
                        target: "$act",
                        input: "@seqin"
                    }
                }
            ]
        })
    );
    check(r.via === expectVia, `batch via ${r.via}, expected ${expectVia}`);
    check(r.applied === 6, `batch applied ${r.applied}, expected 6`);
    check(r.refs && r.refs.btn && r.refs.act, "batch refs btn/act");
    const ws = json(await call("list_widgets", { page: "Batch" })).widgets;
    const ids = new Set(ws.map(w => w.objID));
    check(ids.has(r.refs.btn) && ids.has(r.refs.act), "list_widgets shows btn + act");
    check(ws.some(w => w.type === "TextDashboardWidget"), "list_widgets shows the text widget");
    const conns = json(await call("list_connections", { page: "Batch" })).connections;
    check(
        conns.some(c => c.source === r.refs.btn && c.target === r.refs.act),
        "connection $btn -> $act exists"
    );
}

async function filePass() {
    console.log("\n== file mode (bridge hidden) ==");
    const { client, call } = await connect({
        EEZ_BRIDGE_DISCOVERY: path.join(outDir, "no-bridge-here.json")
    });
    await batchScenario(call, path.join(outDir, "batch-file.eez-project"), "file");
    await client.close();
}

async function livePass() {
    console.log("\n== live mode ==");
    const { client, call } = await connect();

    const tools = await client.listTools();
    console.log("TOOLS:", tools.tools.map(t => t.name).join(", "));
    check(tools.tools.some(t => t.name === "batch"), "batch tool is listed");

    // A fresh project from the template must have zero Checks errors.
    const created = json(await call("create_dashboard_project", { path: projectPath }));
    check(created.live, "create_dashboard_project: EEZ Studio + bridge must be running");
    console.log(
        `studio ${created.studioVersion}, bridge ${created.bridgeVersion}` +
            (created.warning ? ` WARNING: ${created.warning}` : "")
    );
    const fresh = json(await call("get_checks", {}));
    check(fresh.errors === 0, `fresh project has ${fresh.errors} get_checks errors`);

    await call("add_page", { name: "Main" });
    await call("add_variable", { name: "counter", type: "integer", defaultValue: "0" });
    const w = await call("add_widget", {
        page: "Main",
        type: "TextDashboardWidget",
        left: 20,
        top: 20,
        width: 220,
        height: 30,
        data: "counter"
    });
    const objID = json(w).objID;
    const btn = await call("add_widget", {
        page: "Main",
        type: "ButtonDashboardWidget",
        left: 20,
        top: 70,
        width: 160,
        height: 44,
        data: '"Increment"'
    });
    const btnId = json(btn).objID;
    await call("add_event_handler", { page: "Main", objID: btnId, eventName: "CLICKED" });
    const act = await call("add_action_component", {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 260,
        top: 70,
        props: { entries: [{ variable: "counter", value: "counter + 1" }] }
    });
    const actId = json(act).objID;
    await call("connect", {
        page: "Main",
        source: btnId,
        output: "CLICKED",
        target: actId,
        input: "@seqin"
    });
    await call("list_widgets", { page: "Main" });
    await call("get_checks", {});
    await call("save", {});
    await call("validate", {});
    await call("render", { page: "Main", mode: "design" });
    console.log("bound widget objID:", objID);

    await batchScenario(call, path.join(outDir, "batch-live.eez-project"), "live-editor");
    await call("save", {});

    await client.close();
}

async function main() {
    await filePass();
    await livePass();
    console.log("\nMCP SERVER OK. Project:", projectPath);
}

main().catch(e => {
    console.error("MCP TEST FAILED:", e);
    process.exit(1);
});
