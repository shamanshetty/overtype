import * as v from "vscode";
import { Review } from "./review-ui";
import { workspaceTools } from "./workspace-tools";
import { ledger } from "./context";
import spec from "../agent/forge-review.json";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TrueForge } from "@truefoundry/trueforge-sdk";

export interface Conversation {
  connector?: string;
  root?: string;
  url?: string;
  session?: string;
  model?: string;
  previous?: string;
}
export async function turn(
  root: string,
  prompt: string,
  review: Review,
  control: AbortController,
  output: Pick<v.OutputChannel, "append" | "appendLine">,
  selection?: { doc: v.TextDocument; text: string },
  conversation?: Conversation,
  approveCommand?: () => Promise<boolean>,
) {
  const cfg = v.workspace.getConfiguration("forgeReview");
  const baseUrl =
    cfg.get<string>("url") ||
    process.env.TRUEFORGE_URL ||
    "http://127.0.0.1:8790";
  const client = new TrueForge({ baseUrl });
  if (
    conversation &&
    (conversation.root !== root || conversation.url !== baseUrl)
  ) {
    Object.assign(conversation, {
      root,
      url: baseUrl,
      session: undefined,
      previous: undefined,
      connector: undefined,
    });
  }
  const configured = cfg.get<string[]>("models")?.length
    ? cfg.get<string[]>("models")!
    : process.env.TRUEFORGE_MODELS?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) || [];
  const models = configured.length
    ? configured
    : process.env.TRUEFORGE_MODEL
      ? [process.env.TRUEFORGE_MODEL]
      : (await client.models.list()).data.map((m) => m.name);
  if (!models.length) throw Error("Configure a model in TrueForge.");
  const signal = control.signal,
    log = (s: string) => output.appendLine(s);
  const tools = await workspaceTools(root, review, signal, log);
  const budget = Math.max(1, cfg.get<number>("contextBudget") ?? 4000);
  const rows = ledger(
    tools.paths,
    prompt,
    v.window.visibleTextEditors.map((e) =>
      v.workspace.asRelativePath(e.document.uri),
    ),
    budget,
  );
  const included = rows.filter((r) => r.included);
  let used = included.reduce((n, r) => n + r.cost, 0);
  const snippets: string[] = [];
  const words = new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 3),
  );
  if (!selection)
    for (const item of included.slice(0, 8)) {
      if (!/\.(py|ts|js|rs|go|md|rst|toml)$/.test(item.path)) continue;
      const lines = (await tools.read(item.path)).split(/\r?\n/);
      let best = 0,
        maximum = 0;
      for (let i = 0; i < lines.length; i++) {
        const tokens = new Set(lines[i].toLowerCase().split(/[^a-z0-9_]+/));
        const score = [...tokens].filter((t) => words.has(t)).length;
        if (score > maximum) {
          best = i;
          maximum = score;
        }
      }
      if (!maximum) continue;
      const start = Math.max(0, best - 4);
      const block =
        item.path +
        " line " +
        (start + 1) +
        "\n" +
        lines.slice(start, start + 16).join("\n");
      // Conservative byte ceiling applies to excerpts as well as the ranked path list.
      const cost = Math.ceil(Buffer.byteLength(block + "\n") / 4);
      if (used + cost > budget) continue;
      snippets.push(block);
      used += cost;
      log(
        "Excerpt " +
          item.path +
          " - line " +
          (start + 1) +
          " - " +
          cost +
          " estimated tokens",
      );
    }
  log("Context Ledger - " + used + "/" + budget + " estimated tokens");
  for (const row of rows)
    log(
      [
        row.included ? "Included" : "Excluded",
        row.path,
        row.score.toFixed(2),
        row.cost,
        row.reasons.join(", "),
      ].join(" | "),
    );
  prompt +=
    "\nRelevant workspace paths:\n" +
    included.map((r) => r.path).join("\n") +
    "\n" +
    snippets.join("\n") +
    "\nCall the actual propose_edit tool to stage changes; a textual plan does not change the workspace.";
  if (selection) {
    const numbered = selection.text
      .split(/\r?\n/)
      .map((line, index) => index + 1 + " | " + line);
    prompt =
      "Edit the following numbered source lines. Use line numbers from this selection. Make the smallest textual edit on each affected line. Preserve its existing return statement, variable names and indentation.\n" +
      numbered.join("\n") +
      "\n\nUser request: " +
      prompt.split("\n")[0];
  }
  const inlineSpec = selection
    ? {
        instructions:
          "You are a source code editor. For each line that needs to change, provide its original one-based line number, a short exact substring copied from that line and the revised substring. Preserve all unrelated characters. For example to add an item to a list, replace just its closing bracket with comma, the new item and the closing bracket. Leave other lines alone. Check that the revised lines implement every part of the request.",
        responseFormat: {
          type: "json_schema" as const,
          jsonSchema: {
            name: "line_edits",
            strict: true,
            schema: {
              type: "object",
              properties: {
                edits: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    properties: {
                      line: { type: "integer", minimum: 1 },
                      before: {
                        type: "string",
                        description:
                          "Short exact original substring on the numbered line.",
                      },
                      replacement: {
                        type: "string",
                        description: "New text replacing only that substring.",
                      },
                    },
                    required: ["line", "before", "replacement"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["edits"],
              additionalProperties: false,
            },
          },
        },
      }
    : {};
  const name =
      conversation?.connector ?? "forge-review-" + randomUUID().slice(0, 8),
    token = randomUUID();
  if (conversation) conversation.connector = name;
  const http = createServer(async (req, res) => {
    if (req.url !== "/mcp" || req.headers.authorization !== "Bearer " + token) {
      res.writeHead(403).end();
      return;
    }
    const mcp = new McpServer({ name, version: "0.1.0" });
    tools.register(mcp);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void mcp.close();
    });
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
  if (!address || typeof address === "string")
    throw new Error("Missing TCP port");

  let registered = false;
  try {
    await client.settings.mcpServers.create({
      manifest: {
        name,
        type: "remote",
        description: "Workspace tools",
        url: "http://127.0.0.1:" + address.port + "/mcp",
        auth: { type: "header", headers: { Authorization: "Bearer " + token } },
      },
    });
    registered = true;
    for (const model of models) {
      signal.throwIfAborted();
      const reuse = conversation?.session && conversation.model === model;
      const { data } = reuse
        ? { data: { id: conversation!.session! } }
        : await client.sessions.create({
            agent: {
              spec: {
                ...spec,
                ...inlineSpec,
                ...(selection && model.startsWith("google-gemini/")
                  ? {
                      responseFormat: { type: "text" as const },
                      instructions:
                        inlineSpec.instructions +
                        ' Return only JSON: {"edits":[{"line":1,"before":"exact substring","replacement":"revised substring"}]}. Answer directly using the supplied code. No date or external information is needed.',
                    }
                  : {}),
                model: {
                  name: model,
                  params: { temperature: 0, parallelToolCalls: false },
                },
                mcpServers: selection
                  ? []
                  : [
                      {
                        name,
                        preload: true,
                        requireApprovalForTools: ["run_command", "run_tests"],
                      },
                    ],
              },
            },
          });
      if (conversation) {
        conversation.session = data.id;
        conversation.model = model;
        if (!reuse) conversation.previous = undefined;
      }
      const cancel = () => {
        void client.sessions.cancel(data.id).catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        log("Session " + data.id + " - " + model);
        let input: Parameters<
          typeof client.sessions.createTurnStream
        >[1]["input"] = [{ type: "user.message", content: prompt }];
        let turnId = "";

        const events = await client.sessions.createTurnStream(
          data.id,
          { input, previousTurnId: conversation?.previous },
          { abortSignal: signal, maxRetries: 0 },
        );
        for await (const e of events) {
          signal.throwIfAborted();
          if (e.type === "turn.created") turnId = e.turnId;
          if (e.type === "model.message.delta" && e.content)
            output.append(e.content);
          if (e.type === "tool.approval_required") {
            for (const call of e.toolCalls) {
              const allowed = approveCommand
                ? await approveCommand()
                : (await v.window.showWarningMessage(
                    "TrueForge requests permission for a workspace command. Its exact command will be shown before execution.",
                    "Continue",
                    "Deny",
                  )) === "Continue";
              await client.sessions.createTurnEvents(data.id, turnId, {
                events: [
                  {
                    type: "user.tool_approval",
                    threadId: e.threadId,
                    toolCallId: call.id,
                    approval:
                      allowed
                        ? { status: "allow" }
                        : { status: "deny" },
                  },
                ],
              });
            }
          }
          if (e.type === "model.message" && e.toolCalls)
            for (const tool of e.toolCalls)
              log(
                "Tool " +
                  tool.function.name +
                  " " +
                  tool.function.arguments.slice(0, 120),
              );
          if (e.type === "tool.response")
            log("\nTool response " + e.toolCallId);
          if (e.type === "turn.done") {
            if (e.state.status === "error") throw Error(e.state.message);
            if (e.state.status !== "done")
              throw Error("Turn " + e.state.status);

            if (selection && !review.files.size) {
              const content = e.state.output?.content;
              if (typeof content !== "string")
                throw Error("No inline replacement was returned.");
              const payload = JSON.parse(
                content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""),
              );
              const original = selection.text.replace(/\r\n/g, "\n"),
                lines = original.split("\n");
              if (!Array.isArray(payload.edits) || !payload.edits.length)
                throw Error("Model returned no edits.");
              const ranges = payload.edits
                .map(
                  (edit: {
                    line: number;
                    before: string;
                    replacement: string;
                  }) => {
                    if (
                      !Number.isInteger(edit.line) ||
                      edit.line < 1 ||
                      edit.line > lines.length ||
                      typeof edit.before !== "string" ||
                      !edit.before ||
                      typeof edit.replacement !== "string"
                    )
                      throw Error("Invalid selection edit.");
                    const before = edit.before.replace(/\r\n/g, "\n");
                    const start = lines
                      .slice(0, edit.line - 1)
                      .reduce((n, l) => n + l.length + 1, 0);
                    const candidates = [];
                    for (
                      let i = start;
                      i <= start + lines[edit.line - 1].length;
                      i++
                    )
                      if (original.startsWith(before, i)) candidates.push(i);
                    if (candidates.length !== 1)
                      throw Error(
                        "The edit anchor does not uniquely match the source line.",
                      );
                    return {
                      start: candidates[0],
                      end: candidates[0] + before.length,
                      replacement: edit.replacement,
                    };
                  },
                )
                .sort(
                  (a: { start: number }, b: { start: number }) =>
                    b.start - a.start,
                );
              let replacement = original,
                boundary = original.length;
              for (const edit of ranges) {
                if (edit.end > boundary)
                  throw Error("Overlapping selection edits.");
                replacement =
                  replacement.slice(0, edit.start) +
                  edit.replacement +
                  replacement.slice(edit.end);
                boundary = edit.start;
              }
              review.stage(selection.doc, selection.text, replacement);
            }
            if (
              !selection &&
              !review.files.size &&
              models.indexOf(model) < models.length - 1
            )
              throw Error(
                "Model finished without staging an edit; trying fallback.",
              );
            if (conversation) conversation.previous = turnId;
            log(
              "Turn finished - " +
                review.files.size +
                " files staged for review",
            );
            return;
          }
        }
        throw Error("Stream closed before the turn finished.");
      } catch (error) {
        review.clear();
        signal.throwIfAborted();
        log(String(error));
        if (model === models[models.length - 1]) throw error;
        v.window.setStatusBarMessage(
          "Overtype is trying the next model",
          5000,
        );
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }
  } finally {
    http.close();
    http.closeAllConnections();
    if (registered) await client.settings.mcpServers.delete(name);
  }
}
