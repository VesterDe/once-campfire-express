import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
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
  connection.exec("PRAGMA journal_mode=WAL;");
  return connection;
}
export function db() {
  return connection || initialize();
}
export function all(sql, ...params) {
  return db()
    .prepare(sql)
    .all(...params);
}
export function get(sql, ...params) {
  return db()
    .prepare(sql)
    .get(...params);
}
export function run(sql, ...params) {
  return db()
    .prepare(sql)
    .run(...params);
}
export function now() {
  return new Date(process.env.CAMPFIRE_FROZEN_TIME || Date.now())
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .replace(/(\.\d{3})$/, "$1000");
}
export function transaction(fn) {
  const name = `nested_${depth}`,
    nested = depth > 0;
  db().exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
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
