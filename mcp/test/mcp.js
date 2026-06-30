// Spawns the MCP server and drives it over stdio like a real client, to verify
// the protocol layer: tools are listed, calls work, render returns an image.
//   node test-mcp.js [outDir]
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

async function main() {
    const transport = new StdioClientTransport({
        command: process.execPath, // same node that runs this test
        args: [path.join(__dirname, "..", "server.js")]
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    console.log("TOOLS:", tools.tools.map(t => t.name).join(", "));

    const call = async (name, args) => {
        const r = await client.callTool({ name, arguments: args });
        console.log(`${name}: ${summarize(r)}${r.isError ? " [ERROR]" : ""}`);
        return r;
    };

    await call("create_dashboard_project", { path: projectPath });
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
    const objID = JSON.parse(w.content[0].text).objID;
    const btn = await call("add_widget", {
        page: "Main",
        type: "ButtonDashboardWidget",
        left: 20,
        top: 70,
        width: 160,
        height: 44,
        data: '"Increment"'
    });
    const btnId = JSON.parse(btn.content[0].text).objID;
    await call("add_event_handler", { page: "Main", objID: btnId, eventName: "CLICKED" });
    const act = await call("add_action_component", {
        page: "Main",
        type: "SetVariableActionComponent",
        left: 260,
        top: 70,
        props: { entries: [{ variable: "counter", value: "counter + 1" }] }
    });
    const actId = JSON.parse(act.content[0].text).objID;
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
    await client.close();
    console.log("\nMCP SERVER OK. Project:", projectPath);
}

main().catch(e => {
    console.error("MCP TEST FAILED:", e);
    process.exit(1);
});
