import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
const scratch = path.resolve("tmp/tests");
mkdirSync(scratch, { recursive: true });
const files = readdirSync("test")
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => "test/" + name);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, TMPDIR: scratch },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
