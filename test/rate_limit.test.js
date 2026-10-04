import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
mkdirSync("tmp", { recursive: true });
const storage = mkdtempSync("tmp/rate-limit-");
process.env.JOBS_DATABASE_PATH = storage + "/jobs.sqlite3";
const { allowLogin } = await import("../src/rate_limit.js");
test.after(() => rmSync(storage, { recursive: true, force: true }));
test("Login limits count attempts atomically in shared auxiliary SQLite and expire after three minutes", () => {
  for (let i = 0; i < 10; i++)
    assert.equal(allowLogin("192.0.2.1", 1000 + i), true);
  assert.equal(allowLogin("192.0.2.1", 2000), false);
  assert.equal(allowLogin("192.0.2.2", 2000), true);
  assert.equal(allowLogin("192.0.2.1", 181000), true);
});
