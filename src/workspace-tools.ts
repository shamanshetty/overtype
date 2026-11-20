import { tmpdir } from "node:os";
import { previewAccepted } from "./review";
import {
  realpath,
  readFile,
  stat,
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  rm,
} from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as v from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Review } from "./review-ui";
const exec = promisify(execFile);
export async function workspaceTools(
  root: string,
  review: Review,
  signal: AbortSignal,
  log: (s: string) => void,
) {
  const base = await realpath(root);
  const { stdout } = await exec(
    "git",
    [
      "-C",
      base,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ],
    { maxBuffer: 8e6 },
  );
  const paths = stdout
    .split("\0")
    .filter(
      (p) =>
        p &&
        !p
          .split("/")
          .some(
            (s) =>
              s.startsWith(".") ||
              s === "node_modules" ||
              /secret|credential|\.pem$|\.key$/i.test(s),
          ),
    );
  const allowed = new Set(paths);
  async function checkedPath(p: string) {
    signal.throwIfAborted();
    if (!allowed.has(p)) throw Error("Choose an indexed workspace path.");
    const file = path.resolve(base, p);
    if ((await realpath(file)) !== file || (await stat(file)).size > 512000)
      throw Error("Unsupported path or file size.");
    return file;
  }
  async function document(p: string) {
    return v.workspace.openTextDocument(v.Uri.file(await checkedPath(p)));
  }
  async function read(p: string) {
    const file = await checkedPath(p),
      key = v.Uri.file(file).toString();
    const proposal = review.files.get(key);
    if (proposal) return previewAccepted(proposal.original, proposal.hunks);
    const open = v.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === key,
    );
    return open ? open.getText() : readFile(file, "utf8");
  }
  const result = (s: string) => ({
    content: [{ type: "text" as const, text: s }],
  });
  return {
    paths,
    document,
    read,
    register(m: McpServer) {
      async function command(action: "status" | "cli-tests") {
        signal.throwIfAborted();
        const [exe, ...args] =
          action === "status"
            ? ["git", "status", "--short"]
            : ["python", "-m", "pytest", "tests/test_cli.py", "-q"];
        // Each invocation needs a local approval as well as the harness checkpoint.
        const choice = await v.window.showWarningMessage(
          "Run " + [exe, ...args].join(" ") + " in " + base + "?",
          { modal: true },
          "Run",
        );
        if (choice !== "Run") return result("User declined.");
        signal.throwIfAborted();
        let cwd = base;
        try {
          if (action === "cli-tests") {
            cwd = await mkdtemp(path.join(tmpdir(), "astra-tests-"));
            for (const p of paths) {
              signal.throwIfAborted();
              const source = path.resolve(base, p);
              if (
                (await realpath(source)) !== source ||
                !(await stat(source)).isFile()
              )
                continue;
              const dest = path.join(cwd, p);
              await mkdir(path.dirname(dest), { recursive: true });
              const proposal = review.files.get(v.Uri.file(source).toString());
              if (proposal)
                await writeFile(
                  dest,
                  previewAccepted(proposal.original, proposal.hunks),
                  "utf8",
                );
              else await copyFile(source, dest);
            }
          }
          const run = await exec(exe, args, {
            cwd,
            signal,
            timeout: 60000,
            maxBuffer: 512000,
            env: { ...process.env, PYTHONPATH: path.join(cwd, "src") },
          });
          log(action + " passed");
          return result((run.stdout + run.stderr).slice(-8000) || "Completed");
        } catch (error) {
          log(action + " failed");
          return result(String(error).slice(-8000));
        } finally {
          if (cwd !== base)
            await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
        }
      }
      m.registerTool(
        "run_command",
        {
          description:
            "Run an approved command preset. status checks Git and cli-tests runs the Flask CLI suite.",
          inputSchema: { command: z.enum(["status", "cli-tests"]) },
        },
        (a) => command(a.command),
      );
      m.registerTool(
        "run_tests",
        {
          description:
            "Request approval to run the Flask CLI tests against a temporary copy including staged proposals.",
        },
        () => command("cli-tests"),
      );
      m.registerTool(
        "get_repo_map",
        {
          description:
            "List indexed repository paths, optionally filtered by substring.",
          inputSchema: { filter: z.string().optional() },
        },
        ({ filter }) =>
          result(
            paths
              .filter((p) => p.includes(filter || ""))
              .slice(0, 250)
              .join("\n"),
          ),
      );
      async function search(query: string, symbol: boolean) {
        const hits: string[] = [];
        for (const p of paths.filter((p) =>
          /\.(py|ts|js|md|rst|toml)$/.test(p),
        )) {
          const lines = (await read(p)).split(/\r?\n/);
          for (let i = 0; i < lines.length; i++)
            if (
              lines[i].toLowerCase().includes(query.toLowerCase()) &&
              (!symbol ||
                /^\s*(?:async )?(def|class|function|interface)\s/.test(
                  lines[i],
                ))
            ) {
              hits.push(
                p + ":" + (i + 1) + " " + lines[i].trim().slice(0, 150),
              );
              if (hits.length >= 40) return result(hits.join("\n"));
            }
        }
        return result(hits.join("\n"));
      }
      m.registerTool(
        "search_workspace",
        {
          description:
            "Literal case-insensitive source and documentation search.",
          inputSchema: { query: z.string().min(1) },
        },
        ({ query }) => search(query, false),
      );
      m.registerTool(
        "find_symbols",
        {
          description: "Find matching definitions.",
          inputSchema: { name: z.string().min(1) },
        },
        ({ name }) => search(name, true),
      );
      m.registerTool(
        "read_file",
        {
          description: "Read a file excerpt, one-based starting line.",
          inputSchema: {
            path: z.string(),
            offset: z.number().int().positive().optional(),
            limit: z.number().int().min(1).max(160).optional(),
          },
        },
        async (a) => {
          const lines = (await read(a.path)).split(/\r?\n/),
            start = (a.offset ?? 1) - 1;
          log("Read " + a.path);
          return result(
            lines
              .slice(start, start + (a.limit ?? 80))
              .join("\n")
              .slice(0, 16000),
          );
        },
      );
      m.registerTool(
        "note_context",
        {
          description: "Explain why a file matters.",
          inputSchema: { path: z.string(), reason: z.string() },
        },
        (a) => {
          if (!allowed.has(a.path)) throw Error("Unknown path");
          log(a.path + " - " + a.reason);
          return result("Recorded");
        },
      );
      m.registerTool(
        "propose_edit",
        {
          description:
            "Stage one exact unique substring replacement in an existing file. Never writes to disk.",
          inputSchema: {
            path: z.string(),
            before: z.string().min(1),
            after: z.string(),
            reason: z.string(),
          },
        },
        async (a) => {
          const doc = await document(a.path);
          signal.throwIfAborted();
          const count = review.stage(doc, a.before, a.after);
          log("Staged " + a.path + " - " + a.reason);
          return result(count + " pending hunks");
        },
      );
    },
  };
}
