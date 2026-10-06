import { DatabaseSync } from "node:sqlite";
import cluster from "node:cluster";
import { mkdirSync, readFileSync, openSync, readSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
let connection,
  depth = 0;
const callbacks = [];
export function onCommit(fn) {
  if (depth) callbacks.at(-1).push(fn);
  else fn();
}
export function initialize(
  path = process.env.DATABASE_PATH ||
    join(
      process.env.CAMPFIRE_STORAGE_PATH ||
        process.env.STORAGE_PATH ||
        "storage",
      "db/production.sqlite3",
    ),
) {
  if (connection) return connection;
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  connection = new DatabaseSync(path);
  connection.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
  if (
    !connection
      .prepare("SELECT name FROM sqlite_master WHERE name='users'")
      .get()
  ) {
    connection.exec(
      readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  }
  validateSchema(connection);
  // Rails' SQLite adapter defaults: synchronous=NORMAL, mmap 128MB, journal limit 64MB.
  connection.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=67108864; PRAGMA mmap_size=134217728;",
  );
  shmFd = null;
  if (path !== ":memory:" && process.env.EPOCH_SHM !== "0")
    try {
      if (
        connection.prepare("PRAGMA journal_mode").get().journal_mode === "wal"
      )
        shmFd = openSync(resolve(path) + "-shm", "r");
    } catch {
      shmFd = null;
    }
  // HTTP workers never checkpoint inside a request; the primary does it on a timer.
  // With several workers the primary is the writer for posts (post_writer.js), so it
  // never checkpoints either: each HTTP worker runs a PASSIVE checkpoint on its own
  // timer, outside requests, which does not block the writer.
  if (Number(process.env.WEB_WORKERS || "1") > 1) {
    connection.exec("PRAGMA wal_autocheckpoint=0;");
    if (cluster.isWorker)
      setTimeout(
        () =>
          setInterval(() => {
            try {
              connection.exec("PRAGMA wal_checkpoint(PASSIVE);");
            } catch {}
          }, 1000).unref(),
        Math.random() * 1000,
      ).unref();
  }
  return connection;
}
const statements = new Map();
export function stmt(sql) {
  let s = statements.get(sql);
  if (!s) statements.set(sql, (s = db().prepare(sql)));
  return s;
}
// Process-local caches call epoch() and drop their entries when it changes.
// data_version moves on commits from other connections; total_changes on ours.
let epochValue = 0,
  lastVersion = -1,
  lastChanges = -1;
// In WAL mode every commit (by any connection, ours included) and every WAL
// restart rewrites the wal-index header at the start of the -shm file: two
// 48-byte copies, copy 1 written before copy 0. If both copies are equal and
// byte-identical to the header read before the last SQL check, no commit can
// have happened since that check, so the epoch has not moved. Anything else
// (copies differ, header not initialised, read error) takes the SQL check.
let shmFd = null,
  shmGood = false;
const shmNow = Buffer.alloc(96),
  shmSeen = Buffer.alloc(96);
function shmRead() {
  try {
    return (
      readSync(shmFd, shmNow, 0, 96, 0) === 96 &&
      shmNow[12] === 1 &&
      shmNow.compare(shmNow, 48, 96, 0, 48) === 0
    );
  } catch {
    return false;
  }
}
export function epoch() {
  if (depth) return -1;
  if (shmFd !== null) {
    const ok = shmRead();
    if (ok && shmGood && shmNow.equals(shmSeen)) return epochValue;
    shmGood = ok;
    if (ok) shmNow.copy(shmSeen);
  }
  const v = stmt(
    "SELECT (SELECT data_version FROM pragma_data_version) AS v, total_changes() AS c",
  ).get();
  if (v.v !== lastVersion || v.c !== lastChanges) {
    lastVersion = v.v;
    lastChanges = v.c;
    epochValue++;
  }
  return epochValue;
}
export function db() {
  return connection || initialize();
}
export function all(sql, ...params) {
  return stmt(sql).all(...params);
}
export function get(sql, ...params) {
  return stmt(sql).get(...params);
}
export function run(sql, ...params) {
  return stmt(sql).run(...params);
}
export function now() {
  return new Date(process.env.CAMPFIRE_FROZEN_TIME || Date.now())
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .replace(/(\.\d{3})$/, "$1000");
}
// SQLite's busy handler sleeps 1-10ms per retry while holding the whole process.
// Take the write lock with short, growing waits instead (20µs to 1ms, 10s overall).
const pause = new Int32Array(new SharedArrayBuffer(4));
const busy = (error) => (error?.errcode & 0xff) === 5;
function begin() {
  const c = db();
  c.exec("PRAGMA busy_timeout=0");
  try {
    let deadline = 0;
    for (let wait = 0.02; ; wait = Math.min(wait * 1.5, 1)) {
      try {
        c.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        if (!busy(error)) throw error;
        deadline ||= Date.now() + 10000;
        if (Date.now() > deadline) throw error;
      }
      Atomics.wait(pause, 0, 0, wait);
    }
  } finally {
    c.exec("PRAGMA busy_timeout=10000");
  }
}
// Like transaction(), but while another process holds the write lock this process
// keeps serving other work: it retries BEGIN IMMEDIATE from the event loop.
let begun = false;
export async function writeTransaction(fn) {
  if (depth) return transaction(fn);
  const c = db();
  let deadline = 0;
  for (;;) {
    c.exec("PRAGMA busy_timeout=0");
    try {
      c.exec("BEGIN IMMEDIATE");
      begun = true;
      break;
    } catch (error) {
      if (!busy(error)) throw error;
      deadline ||= Date.now() + 10000;
      if (Date.now() > deadline) throw error;
    } finally {
      c.exec("PRAGMA busy_timeout=10000");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return transaction(fn);
}
export function transaction(fn) {
  const name = `nested_${depth}`,
    nested = depth > 0;
  if (nested) db().exec(`SAVEPOINT ${name}`);
  else if (begun) begun = false;
  else begin();
  depth++;
  callbacks.push([]);
  let result, hooks;
  try {
    result = fn();
    if (result && typeof result.then === "function")
      throw new TypeError("SQLite transactions must be synchronous");
    db().exec(nested ? `RELEASE ${name}` : "COMMIT");
    hooks = callbacks.pop();
  } catch (error) {
    callbacks.pop();
    db().exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    throw error;
  } finally {
    depth--;
  }
  if (nested) callbacks.at(-1).push(...hooks);
  else for (const callback of hooks) callback();
  return result;
}

function validateSchema(connection) {
  const required = {
    accounts: [
      "id",
      "name",
      "join_code",
      "settings",
      "custom_styles",
      "singleton_guard",
      "created_at",
      "updated_at",
    ],
    users: [
      "id",
      "name",
      "email_address",
      "password_digest",
      "role",
      "status",
      "bot_token",
      "bio",
      "created_at",
      "updated_at",
    ],
    rooms: ["id", "name", "type", "creator_id", "created_at", "updated_at"],
    memberships: [
      "id",
      "room_id",
      "user_id",
      "involvement",
      "connections",
      "connected_at",
      "unread_at",
      "created_at",
      "updated_at",
    ],
    messages: [
      "id",
      "room_id",
      "creator_id",
      "client_message_id",
      "created_at",
      "updated_at",
    ],
    action_text_rich_texts: [
      "id",
      "record_id",
      "record_type",
      "name",
      "body",
      "created_at",
      "updated_at",
    ],
    active_storage_blobs: [
      "id",
      "key",
      "filename",
      "content_type",
      "byte_size",
      "checksum",
      "metadata",
      "service_name",
      "created_at",
    ],
    active_storage_attachments: [
      "id",
      "name",
      "record_type",
      "record_id",
      "blob_id",
      "created_at",
    ],
    active_storage_variant_records: ["id", "blob_id", "variation_digest"],
    boosts: [
      "id",
      "message_id",
      "booster_id",
      "content",
      "created_at",
      "updated_at",
    ],
    sessions: [
      "id",
      "user_id",
      "token",
      "user_agent",
      "ip_address",
      "last_active_at",
      "created_at",
      "updated_at",
    ],
    searches: ["id", "user_id", "query", "created_at", "updated_at"],
    bans: ["id", "user_id", "ip_address", "created_at", "updated_at"],
    push_subscriptions: [
      "id",
      "user_id",
      "endpoint",
      "p256dh_key",
      "auth_key",
      "user_agent",
      "created_at",
      "updated_at",
    ],
    webhooks: ["id", "user_id", "url", "created_at", "updated_at"],
    message_search_index: ["body"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const installed = new Set(
      connection
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((c) => c.name),
    );
    const missing = columns.filter((c) => !installed.has(c));
    if (missing.length)
      throw new Error(
        `Unsupported Campfire database schema: ${table} missing ${missing.join(", ")}. Upgrade the Rails installation to the pinned reference schema before importing it.`,
      );
  }
  const fts = connection
    .prepare("SELECT sql FROM sqlite_master WHERE name='message_search_index'")
    .get()?.sql;
  if (!/USING\s+fts5\b/i.test(fts || ""))
    throw new Error(
      "Unsupported Campfire database schema: message_search_index must be FTS5",
    );
}
