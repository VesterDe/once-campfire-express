import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const temp = mkdtempSync(join(tmpdir(), "campfire-express-rows-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { initialize, run } = await import("../src/db.js");
const { messagesForRoom } = await import("../src/domain.js");
after(() => rmSync(temp, { recursive: true, force: true }));
// Room message rows are kept per query until any commit from any connection.
test("room message rows are reused per epoch and dropped on any commit", () => {
  initialize();
  const t = "2026-01-01 00:00:00.000000";
  run("INSERT INTO users(name,created_at,updated_at) VALUES('u',?,?)", t, t);
  run(
    "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES('r','Rooms::Open',1,?,?)",
    t,
    t,
  );
  const post = (i) =>
    run(
      "INSERT INTO messages(client_message_id,creator_id,room_id,created_at,updated_at) VALUES(?,1,1,?,?)",
      "c" + i,
      `2026-01-01 00:00:${String(i).padStart(2, "0")}.000000`,
      t,
    );
  for (let i = 1; i <= 3; i++) post(i);
  const a = messagesForRoom(1);
  assert.equal(a.length, 3);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a[0]));
  assert.equal(messagesForRoom(1), a, "same epoch, same list");
  assert.notEqual(messagesForRoom(1, { before: "3" }), a, "other query");
  assert.deepEqual(
    messagesForRoom(1, { before: "3" }).map((m) => m.id),
    [1, 2],
  );
  post(4);
  assert.deepEqual(
    messagesForRoom(1).map((m) => m.id),
    [1, 2, 3, 4],
    "own commit drops the list",
  );
  const other = new DatabaseSync(join(temp, "db/production.sqlite3"));
  other.exec(
    "INSERT INTO messages(client_message_id,creator_id,room_id,created_at,updated_at) VALUES('c5',1,1,'2026-01-01 00:00:05.000000','x')",
  );
  other.close();
  assert.deepEqual(
    messagesForRoom(1).map((m) => m.id),
    [1, 2, 3, 4, 5],
    "another connection's commit drops the list",
  );
});
