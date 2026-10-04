import test from "node:test";
import assert from "node:assert/strict";
import { initialize, transaction, onCommit, get, run } from "../src/db.js";
initialize(":memory:");
test("Nested post-commit work runs only after durable outer commit and disappears on rollback", () => {
  const observed = [];
  assert.throws(() =>
    transaction(() => {
      run(
        "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
        "Rolled back",
        "abc",
        "2026-01-01",
        "2026-01-01",
      );
      transaction(() => onCommit(() => observed.push("must not run")));
      throw new Error("rollback");
    }),
  );
  assert.deepEqual(observed, []);
  assert.equal(get("SELECT id FROM accounts"), undefined);
  transaction(() => {
    run(
      "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
      "Committed",
      "abc",
      "2026-01-01",
      "2026-01-01",
    );
    transaction(() =>
      onCommit(() => observed.push(get("SELECT name FROM accounts").name)),
    );
    assert.deepEqual(observed, []);
  });
  assert.deepEqual(observed, ["Committed"]);
});
