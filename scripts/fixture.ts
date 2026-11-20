import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { runSpike } from "../src/spike";

// A deterministic provider for transport testing. Only TrueForge calls this endpoint.
async function main() {
  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { messages, tools } = JSON.parse(body);
      const reply = messages.findLast((message: {role: string}) => message.role === "tool");
      const probe = tools?.find((tool: {function: {name: string}}) => tool.function.name.includes("editor_probe"));
      if (!reply && !probe) throw new Error("TrueForge did not advertise editor_probe");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (delta: object, finish_reason: string | null) => {
        const data = { id: "fixture-turn", model: "fixture", object: "chat.completion.chunk", created: 0,
          choices: [{ index: 0, delta, finish_reason }] };
        res.write("data: " + JSON.stringify(data) + "\n\n");
      };
      emit(reply ? {role:"assistant", content: JSON.stringify(reply.content)} : {
        role:"assistant", tool_calls:[{ index:0, id:"call_probe", type:"function", function:{ name:probe.function.name, arguments:"{}" } }]
      }, null);
      emit({}, reply ? "stop" : "tool_calls");
      res.end("data: [DONE]\n\n");
    } catch (error) {
      console.error(String(error));
      res.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const client = new TrueForge({baseUrl:process.env.TRUEFORGE_URL || "http://127.0.0.1:8790"});
  const name = "fixture-" + randomUUID().slice(0,8);
  let registered = false;
  try {
    await client.settings.modelProviders.create({manifest:{type:"custom", name,
      baseUrl:"http://127.0.0.1:" + address.port + "/v1", models:[{name:"fixture",modelId:"fixture",properties:{contextLength:16000,maxOutputTokens:512}}]}});
    registered = true;
    process.env.TRUEFORGE_MODEL = name + "/fixture";
    const editor = process.env.FORGE_VSCODE_EXE;
    if (editor) {
      const profile = await mkdtemp(join(tmpdir(), "forge-review-test-"));
      try {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const host = spawn(editor, ["--disable-extensions", "--disable-updates", "--user-data-dir=" + profile,
          "--extensionDevelopmentPath=" + resolve("."), "--extensionTestsPath=" + resolve("dist/scripts/host-test.js")],
          { stdio: "inherit", windowsHide: true, env });
        const [code] = await once(host, "exit");
        if (code !== 0) throw new Error("Extension host failed with exit code " + code);
        console.log("PASS: extension host command verified the MCP round trip.");
      } finally {
        await rm(profile, {recursive:true, force:true, maxRetries:4});
      }
    } else {
      await runSpike(console.log);
    }
  } finally {
    server.close();
    server.closeAllConnections();
    if (registered) await client.settings.modelProviders.delete(name);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
