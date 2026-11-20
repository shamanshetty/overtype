import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Review } from "../src/review-ui";
import { workspaceTools } from "../src/workspace-tools";

export async function verifyTools(root: string) {
  const review = new Review(),
    control = new AbortController();
  const api = await workspaceTools(root, review, control.signal, () => {});
  const server = new McpServer({ name: "astra-test", version: "1" });
  api.register(server);
  const client = new Client({ name: "verification", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const file = "src/flask/helpers.py",
      start = await readFile(join(root, file), "utf8");
    assert.ok((await call("read_file", { path: "../outside" })).isError);
    assert.ok((await call("read_file", { path: ".git/config" })).isError);
    const symbols = await call("find_symbols", { name: "get_debug_flag" });
    assert.ok(JSON.stringify(symbols.content).includes(file));
    const change = await call("propose_edit", {
      path: file,
      before: "def get_debug_flag(",
      after: "def sample_review_flag(",
      reason: "Verify overlay isolation",
    });
    assert.ok(!change.isError, JSON.stringify(change.content));
    assert.equal(await readFile(join(root, file), "utf8"), start);
    const preview = await call("read_file", { path: file, limit: 160 });
    assert.ok(JSON.stringify(preview.content).includes("sample_review_flag"));
    control.abort();
    assert.ok(
      (
        await call("propose_edit", {
          path: file,
          before: "def sample_review_flag(",
          after: "def stale_edit(",
          reason: "late call",
        })
      ).isError,
    );
    review.clear();
    console.log(
      "PASS eight MCP tools listed; path bounds, symbol lookup, staged read, unchanged disk and late-call rejection verified.",
    );
  } finally {
    await client.close();
    await server.close();
  }
}
