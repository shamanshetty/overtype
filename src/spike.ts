import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TrueForge } from "@truefoundry/trueforge-sdk";

export async function runSpike(log: (line: string) => void) {
  const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_URL || "http://127.0.0.1:8790" });
  const models = (await client.models.list()).data;
  const model = process.env.TRUEFORGE_MODEL || (models.length === 1 && models[0].name);
  if (!model) throw new Error("Set TRUEFORGE_MODEL to a configured provider/model. Available: " + models.map(m => m.name).join(", "));

  const name = "forge-review-" + randomUUID().slice(0, 8);
  const token = randomUUID();
  const nonce = randomUUID();
  let calls = 0;
  const http = createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.headers.authorization !== "Bearer " + token) {
      res.writeHead(403).end();
      return;
    }
    const mcp = new McpServer({ name, version: "0.1.0" });
    mcp.registerTool("editor_probe", {
      description: "Read the one-time proof from the editor.",
      annotations: { readOnlyHint: true }
    }, () => {
      calls++;
      return { content: [{ type: "text", text: nonce }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP port");
  let registered = false;
  let runningSession: string | undefined;
  try {
    await client.settings.mcpServers.create({ manifest: {
      name, type: "remote", description: "Overtype editor probe",
      url: "http://127.0.0.1:" + address.port + "/mcp",
      auth: { type: "header", headers: { Authorization: "Bearer " + token } }
    } });
    registered = true;
    const { data } = await client.sessions.create({ agent: { spec: {
      instructions: "Use the editor_probe tool exactly once. When its reply arrives, copy the result verbatim as your final answer.",
      model: { name: model, params: { parallelToolCalls: false, temperature: 0 } }, config: { iterationLimit: 3 }, mcpServers: [{ name, preload: true, requireApprovalForTools: [] }]
    } } });
    log("session " + data.id + " using " + model);
    runningSession = data.id;
    const stream = await client.sessions.createTurnStream(data.id, { input: [{
      type: "user.message", content: "Call the editor_probe tool once and reply with its exact result."
    }] }, { abortSignal: AbortSignal.timeout(180000), maxRetries: 0 });
    let responseSeen = false;
    let success = false;
    for await (const event of stream) {
      log(event.type);
      if (event.type === "tool.response" && event.content.includes(nonce)) responseSeen = true;
      if (event.type === "turn.done") {
        runningSession = undefined;
        log("terminal " + event.state.status);
        if (event.state.status === "error") throw new Error(event.state.message);
        success = event.state.status === "done" && JSON.stringify(event.state.output?.content ?? "").includes(nonce);
      }
    }
    if (!success || !responseSeen || calls !== 1) throw new Error("Missing proof of exactly one editor tool round trip.");
    log("PASS: authenticated editor tool called once and its fresh nonce returned.");
  } finally {
    try {
      if (runningSession) await client.sessions.cancel(runningSession);
    } finally {
      http.close();
      http.closeAllConnections();
      if (registered) await client.settings.mcpServers.delete(name);
    }
  }
}
