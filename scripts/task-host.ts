import { TrueForge } from "@truefoundry/trueforge-sdk";
import { randomUUID } from "node:crypto";
import * as v from "vscode";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Review } from "../src/review-ui";
import { turn } from "../src/turn";
import { verifyTools } from "./mcp-host";
import { writeFileSync } from "node:fs";
export async function run() {
  try {
    await execute();
    writeFileSync(process.env.ASTRA_RESULT!, "PASS");
  } catch (e) {
    writeFileSync(process.env.ASTRA_RESULT!, String(e));
    throw e;
  }
}
async function execute() {
  const root = process.env.FORGE_ROOT!,
    task = process.env.FORGE_TASK!;
  if (task === "tools") {
    await verifyTools(root);
    return;
  }
  const output = v.window.createOutputChannel("Overtype verification");
  const review = new Review();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const python = (...args: string[]) => {
    try {
      return execFileSync(process.env.FORGE_PYTHON || "python", args, {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 4e6,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      console.error(failure.stdout, failure.stderr);
      throw error;
    }
  };
  const helper = await v.workspace.openTextDocument(
    v.Uri.file(join(root, "src/flask/helpers.py")),
  );
  const selection = helper
    .getText()
    .match(/^def get_debug_flag\([^]*?(?=^def |^class )/m)?.[0];
  assert.ok(selection);
  if (task === "review") {
    const original = helper.getText(),
      key = helper.uri.toString();
    const text = "def get_debug_flag(";
    const editor = await v.window.showTextDocument(helper);
    review.stage(helper, text, "def reviewed_flag(");
    assert.equal(helper.getText(), original);
    assert.equal(git("status", "--porcelain"), "");
    const registration = v.workspace.registerTextDocumentContentProvider(
      "forge-review",
      review,
    );
    await review.open(key);
    const virtual = await v.workspace.openTextDocument({
      content: review.provideTextDocumentContent(review.virtual(key)),
    });
    assert.ok(virtual.getText().includes("def reviewed_flag("));
    await review.decide(key, review.files.get(key)!.revision, 0, true);
    assert.ok(helper.getText().includes("def reviewed_flag("));
    await v.window.showTextDocument(editor.document);
    await v.commands.executeCommand("undo");
    assert.equal(helper.getText(), original);
    registration.dispose();
    review.stage(helper, text, "def rejected_flag(");
    await review.decide(key, review.files.get(key)!.revision, 0, false);
    assert.equal(review.files.size, 0);
    assert.equal(helper.getText(), original);
    return;
  }
  const pause = async (ms: number) => {
    if (process.env.ASTRA_RECORD) await new Promise((r) => setTimeout(r, ms));
  };
  if (process.env.ASTRA_RECORD) {
    const editor = await v.window.showTextDocument(helper);
    const first = helper.getText().indexOf(selection);
    editor.selection = new v.Selection(
      helper.positionAt(first),
      helper.positionAt(first + selection.length),
    );
    editor.revealRange(editor.selection, v.TextEditorRevealType.InCenter);
    await pause(2200);
    v.workspace.registerTextDocumentContentProvider("forge-review", review);
    v.languages.registerCodeLensProvider({ scheme: "forge-review" }, review);
    output.show(true);
  }
  const instruction =
    "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
  const goal =
    task === "b"
      ? "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands."
      : instruction + "\nsrc/flask/helpers.py\n" + selection;
  output.appendLine(
    "Task " + task.toUpperCase() + " | " + (task === "b" ? goal : instruction),
  );
  await pause(2100);
  if (task === "c") {
    process.env.TRUEFORGE_URL = "http://127.0.0.1:1";
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      await assert.rejects(
        turn(root, goal, review, new AbortController(), output),
      );
      await new Promise((r) => setTimeout(r, 15));
      assert.ok(ticks > 0);
      assert.equal(review.files.size, 0);
      assert.equal(git("status", "--porcelain"), "");
    } finally {
      clearInterval(timer);
    }
    delete process.env.TRUEFORGE_URL;
    const client = new TrueForge({ baseUrl: "http://127.0.0.1:8790" });
    const secondary =
      process.env.TRUEFORGE_MODEL || (await client.models.list()).data[0]?.name;
    assert.ok(secondary, "Configure a working fallback model.");
    const failed = "astra-offline-" + randomUUID().slice(0, 8);
    await client.settings.modelProviders.create({
      manifest: {
        name: failed,
        type: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [
          {
            name: "offline",
            modelId: "offline",
            properties: { contextLength: 4096 },
          },
        ],
      },
    });
    try {
      process.env.TRUEFORGE_MODELS = failed + "/offline," + secondary;
      await turn(root, goal, review, new AbortController(), output, {
        doc: helper,
        text: selection,
      });
      assert.equal(review.files.size, 1);
      assert.equal(git("status", "--porcelain"), "");
    } finally {
      delete process.env.TRUEFORGE_MODELS;
      await client.settings.modelProviders.delete(failed);
    }
  } else {
    await turn(
      root,
      goal,
      review,
      new AbortController(),
      output,
      task === "a" ? { doc: helper, text: selection } : undefined,
      undefined,
      async () => false,
    );
  }
  assert.equal(git("status", "--porcelain"), "");
  if (process.env.ASTRA_RECORD && review.files.size) {
    await review.open(review.files.keys().next().value);
    await pause(3500);
  }
  const expected =
    task !== "b"
      ? ["src/flask/helpers.py"]
      : ["docs/cli.rst", "src/flask/cli.py", "tests/test_cli.py"];
  assert.deepEqual(
    [...review.files.values()]
      .map((p) => v.workspace.asRelativePath(p.uri))
      .sort(),
    expected,
  );
  for (const [key, p] of [...review.files]) {
    await review.decide(key, p.revision, undefined, true);
    assert.ok(await (await v.workspace.openTextDocument(p.uri)).save());
  }
  if (task !== "b") {
    python(
      "-c",
      "import os; from flask.helpers import get_debug_flag as f\nfor value in ['off','n','OFF','N','1']:\n os.environ['FLASK_DEBUG']=value\n assert f() == (value=='1')\nassert all(x in f.__doc__.lower() for x in ['off','false','no','0','n'])",
    );
  } else {
    python(
      "-c",
      "from flask import Flask; from flask.cli import FlaskGroup; import json; a=Flask('demo'); a.config.update({s:'hidden' for s in ['MY_SECRET','DB_PASSWORD','TOKEN','API_KEY']}); cli=FlaskGroup(create_app=lambda: a); runner=a.test_cli_runner(); r=runner.invoke(cli, ['config']); assert r.exit_code==0,r.output; data=json.loads(r.output); assert all(data[k]=='***' for k in ['MY_SECRET','DB_PASSWORD','TOKEN','API_KEY']); assert 'config' in runner.invoke(cli, ['--help']).output",
    );
  }
  const result = python("-m", "pytest", "tests/test_cli.py", "-q");
  console.log(result);
  output.show(true);
  output.appendLine(result);
  await pause(3000);
}
