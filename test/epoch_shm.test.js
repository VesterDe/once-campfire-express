import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const temp = mkdtempSync(join(tmpdir(), "campfire-express-epoch-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { initialize, epoch, run, transaction } = await import("../src/db.js");
after(() => rmSync(temp, { recursive: true, force: true }));
// epoch() skips its SQL while the -shm wal-index header is unchanged; every
// commit, from this connection or another one, and every checkpoint+restart
// must still move it.
test("epoch moves on every commit from any connection, and only then", () => {
  initialize();
  const other = new DatabaseSync(join(temp, "db/production.sqlite3"));
  other.exec("PRAGMA busy_timeout=5000");
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES('a','j','t','t')",
  );
  let e = epoch();
  for (let i = 0; i < 50; i++) {
    assert.equal(epoch(), e, "no commit, same epoch");
    if (i % 3 === 0) other.exec(`UPDATE accounts SET join_code='j${i}'`);
    else if (i % 3 === 1)
      run(
        "UPDATE accounts SET name=? WHERE id=(SELECT max(id) FROM accounts)",
        "y" + i,
      );
    else {
      other.exec("PRAGMA wal_checkpoint(RESTART)");
      other.exec(`UPDATE accounts SET name='z${i}'`);
    }
    const next = epoch();
    assert.notEqual(next, e, "commit " + i + " moves the epoch");
    e = next;
  }
  transaction(() => {
    assert.equal(epoch(), -1);
    run("UPDATE accounts SET name='t'");
  });
  assert.notEqual(epoch(), e);
  other.close();
});
