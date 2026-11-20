import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function main() {
  const task = process.argv[2];
  if (!["a", "b", "c", "review", "tools"].includes(task))
    throw Error("Expected a, b, c or review.");
  const temp = await mkdtemp(join(realpathSync.native(tmpdir()), "forge-flask-"));
  try {
    const repo = join(temp, "flask");
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        "3.1.3",
        "https://github.com/pallets/flask.git",
        repo,
      ],
      { stdio: "inherit" },
    );
    const env = {
      ...process.env,
      FORGE_TASK: task,
      ASTRA_RESULT: join(temp, "host-result.txt"),
      FORGE_ROOT: repo,
      PYTHONPATH: join(repo, "src"),
      PYTHONDONTWRITEBYTECODE: "1",
    };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    const exe =
      process.env.FORGE_VSCODE_EXE ||
      (process.platform === "win32"
        ? join(process.env.LOCALAPPDATA!, "Programs/Microsoft VS Code/Code.exe")
        : "code");
    {
      const userDir = join(temp, "profile", "User");
      await mkdir(userDir, { recursive: true });
      await writeFile(
        join(userDir, "settings.json"),
        JSON.stringify({
          "window.title": "Overtype evidence " + task,
          "workbench.startupEditor": "none",
          "window.zoomLevel": 1,
          "workbench.secondarySideBar.defaultVisibility": "hidden",
          "chat.disableAIFeatures": true,
          "extensions.autoUpdate": false,
          "extensions.autoCheckUpdates": false,
          "security.workspace.trust.enabled": false,
        }),
      );
    }
    const host = spawn(
      exe,
      [
        "--disable-workspace-trust",
        "--disable-extensions",
        "--disable-updates",
        "--user-data-dir=" + join(temp, "profile"),
        "--extensionDevelopmentPath=" + resolve("."),
        "--extensionTestsPath=" + resolve("dist/scripts/task-host.js"),
        repo,
      ],
      { env, stdio: "inherit" },
    );
    const [code] = await once(host, "exit");
    const verdict = await readFile(env.ASTRA_RESULT, "utf8").catch(
      () => "Host exited without returning a result.",
    );
    console.log(task, code, verdict);
    if (verdict !== "PASS" || code !== 0)
      throw Error("Task " + task + ": " + verdict);
  } finally {
    await rm(temp, {
      force: true,
      recursive: true,
      maxRetries: 5,
      retryDelay: 500,
    });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
