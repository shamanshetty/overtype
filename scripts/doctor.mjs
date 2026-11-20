import { access, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { TrueForge } from "@truefoundry/trueforge-sdk";
const [major, minor] = process.versions.node.split(".").map(Number);
try {
  if (major < 22 || (major === 22 && minor < 14))
    throw Error("Install Node 22.14 or newer.");
  const spec = JSON.parse(
    await readFile(
      new URL("../agent/forge-review.json", import.meta.url),
      "utf8",
    ),
  );
  if (!spec.instructions) throw Error("Agent definition is incomplete.");
  await access("src");
  execFileSync("git", ["rev-parse", "--show-toplevel"]);
  const client = new TrueForge({
    baseUrl: process.env.TRUEFORGE_URL || "http://127.0.0.1:8790",
  });
  const models = (await client.models.list()).data.map((x) => x.name);
  if (!models.length)
    throw Error(
      "Configure at least one model in the local TrueForge dashboard.",
    );
  console.log(
    "Node",
    process.versions.node,
    "� agent definition loaded � Git workspace accessible",
  );
  console.log("Configured TrueForge models:", models.join(", "));
  if (models.length < 2)
    console.log("Configure a second model to exercise automatic fallback.");
  execFileSync(process.execPath, ["dist/scripts/fixture.js"], {
    stdio: "inherit",
  });
} catch (error) {
  console.error(
    error.message,
    "Start npm run harness, run npm run build, and retry.",
  );
  process.exitCode = 1;
}
