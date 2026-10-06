import { DatabaseSync } from "node:sqlite";
import cluster from "node:cluster";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import webpush from "web-push";
import { get, all, run } from "./db.js";
import { publicAddress, resolvePublic, requestPinned } from "./opengraph.js";
import {
  purgeBlob,
  processAttachment,
  storeUpload,
  stagedFiles,
} from "./storage.js";

// Rails Push::Subscription: deliver only to https on port 443 at a permitted push service host.
const PERMITTED_PUSH_HOSTS = [
  "jmt17.google.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "notify.windows.com",
];
const permittedSeen = new Map();
export function permittedPushEndpoint(endpoint) {
  let v = permittedSeen.get(endpoint);
  if (v === undefined) {
    if (permittedSeen.size >= 10000) permittedSeen.clear();
    permittedSeen.set(endpoint, (v = permittedUncached(endpoint)));
  }
  return v;
}
function permittedUncached(endpoint) {
  if (!endpoint || /\s/.test(endpoint)) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443"))
    return false;
  const host = url.hostname.toLowerCase();
  return PERMITTED_PUSH_HOSTS.some((h) => host === h || host.endsWith("." + h));
}
let connection,
  timer,
  working = false,
  stopping = false;
export function jobsDb() {
  if (connection) return connection;
  const file =
    process.env.JOBS_DATABASE_PATH ||
    path.join(
      process.env.CAMPFIRE_STORAGE_PATH ||
        process.env.STORAGE_PATH ||
        "storage",
      "db/jobs.sqlite3",
    );
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  connection = new DatabaseSync(file);
  connection.exec(
    "PRAGMA busy_timeout=10000;PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at REAL NOT NULL,lease_until REAL,lease_token TEXT,status TEXT NOT NULL DEFAULT 'ready',last_error TEXT)",
  );
  // Same as db.js: HTTP workers never checkpoint inside a request; the primary does it on a timer.
  if (cluster.isWorker) connection.exec("PRAGMA wal_autocheckpoint=0;");
  else if (Number(process.env.WEB_WORKERS || "1") > 1)
    setInterval(() => {
      try {
        connection.exec("PRAGMA wal_checkpoint(PASSIVE);");
      } catch {}
    }, 1000).unref();
  return connection;
}
const statements = new Map();
function prepared(sql) {
  let s = statements.get(sql);
  if (!s) statements.set(sql, (s = jobsDb().prepare(sql)));
  return s;
}
export function enqueue(kind, data) {
  return Number(
    prepared("INSERT INTO jobs(payload,available_at) VALUES(?,?)").run(
      JSON.stringify({ kind, data }),
      Date.now() / 1000,
    ).lastInsertRowid,
  );
}
// Insert several jobs in one jobs-database transaction. When the jobs database is
// locked, retry on the event loop instead of blocking in SQLite's busy handler.
function tryEnqueueMany(list) {
  const db = jobsDb(),
    insert = prepared("INSERT INTO jobs(payload,available_at) VALUES(?,?)");
  db.exec("PRAGMA busy_timeout=0");
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (/busy|locked/i.test(String(error?.message))) return false;
    throw error;
  } finally {
    db.exec("PRAGMA busy_timeout=10000");
  }
  try {
    const at = Date.now() / 1000;
    for (const [kind, data] of list)
      insert.run(JSON.stringify({ kind, data }), at);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}
export function enqueueMany(list) {
  if (!list.length || tryEnqueueMany(list)) return;
  const started = Date.now();
  const retry = () => {
    try {
      if (Date.now() - started > 10000)
        // Same limit as busy_timeout: stop yielding and wait in SQLite like enqueue() does.
        for (const [kind, data] of list) enqueue(kind, data);
      else if (!tryEnqueueMany(list)) setImmediate(retry);
    } catch (error) {
      console.error("Campfire enqueue failed:", error.message);
    }
  };
  setImmediate(retry);
}
export function claim(at = Date.now() / 1000) {
  const db = jobsDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = prepared(
      "SELECT * FROM jobs WHERE status='ready' AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY id LIMIT 1",
    ).get(at, at);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    const token = crypto.randomBytes(16).toString("hex");
    prepared(
      "UPDATE jobs SET attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?",
    ).run(at + 120, token, row.id);
    db.exec("COMMIT");
    return {
      ...row,
      attempts: row.attempts + 1,
      lease_token: token,
      lease_until: at + 120,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function finish(job, error = null, at = Date.now() / 1000) {
  if (!error)
    return prepared("DELETE FROM jobs WHERE id=? AND lease_token=?").run(
      job.id,
      job.lease_token,
    ).changes;
  return prepared(
    "UPDATE jobs SET lease_until=NULL,lease_token=NULL,available_at=?,status=?,last_error=? WHERE id=? AND lease_token=?",
  ).run(
    at + Math.min(300, 2 ** job.attempts),
    job.attempts >= 5 ? "dead" : "ready",
    String(error).slice(0, 1000),
    job.id,
    job.lease_token,
  ).changes;
}
export async function perform(kind, data) {
  if (kind === "purge") {
    purgeBlob(data.blob_id);
    return;
  }
  if (kind === "media") {
    const blob = get(
      "SELECT * FROM active_storage_blobs WHERE id=?",
      data.blob_id,
    );
    if (blob) await processAttachment(blob);
    return;
  }
  const domain = await import("./domain.js");
  if (kind === "ban-content") {
    for (const message of all(
      "SELECT * FROM messages WHERE creator_id=?",
      data.user_id,
    ))
      await domain.deleteMessage(message);
    return;
  }
  const message = get(
    "SELECT m.*,r.name AS room_name,r.type AS room_type,u.name AS creator_name FROM messages m JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=m.creator_id WHERE m.id=?",
    data.message_id,
  );
  if (!message) return;
  const body =
    get(
      "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      message.id,
    )?.body || "";
  const { messagePlainText } = await import("./richtext.js");
  async function reply(text, attachment = null) {
    let result;
    try {
      result = stagedFiles(() =>
        domain.createMessage(
          message.room_id,
          hookUserId,
          text,
          crypto.randomUUID(),
        ),
      );
      if (attachment) {
        const blob = storeUpload(
          attachment,
          "Message",
          result.id,
          "attachment",
        );
        await processAttachment(blob);
        domain.indexMessage(result.id, text, blob.filename);
      }
    } catch (error) {
      if (result) domain.deleteMessage(result, { broadcast: false });
      throw error;
    }
    domain.publishMessage(result);
    domain.notifyMessage(result, { webhooks: false });
    return result;
  }
  let hookUserId;
  if (kind === "webhook") {
    const hook = get(
      "SELECT w.*,u.name,u.bot_token,u.status FROM webhooks w JOIN users u ON u.id=w.user_id WHERE w.id=?",
      data.webhook_id,
    );
    if (
      !hook ||
      hook.status !== 0 ||
      !get(
        "SELECT id FROM memberships WHERE user_id=? AND room_id=?",
        hook.user_id,
        message.room_id,
      )
    )
      return;
    hookUserId = hook.user_id;
    const payload = {
      user: { id: message.creator_id, name: message.creator_name },
      room: {
        id: message.room_id,
        name: message.room_name,
        path: `/rooms/${message.room_id}/${hook.user_id}-${hook.bot_token}/messages`,
      },
      message: {
        id: message.id,
        body: {
          html: body,
          plain: messagePlainText(message.id, body)
            .replaceAll(`@${hook.name}`, "")
            .trim(),
        },
        path: `/rooms/${message.room_id}/@${message.id}`,
      },
    };
    const url = new URL(hook.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("invalid webhook URL");
    // Only administrators configure webhook endpoints; preserve legitimate internal bot services.
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const address = net.isIP(hostname)
      ? { address: hostname, family: net.isIP(hostname) }
      : await dns.lookup(hostname);
    let response;
    try {
      response = await requestPinned(url, address, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        maxBytes: 50 * 1024 * 1024,
      });
    } catch (error) {
      if (String(error).includes("timeout")) {
        await reply("Failed to respond within 7 seconds");
        return;
      }
      throw error;
    }
    const type = response.headers["content-type"]?.split(";")[0];
    if (response.status === 200 && ["text/plain", "text/html"].includes(type))
      await reply(response.body.toString("utf8"));
    else if (type && response.body.length) {
      const extensions = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "application/pdf": "pdf",
        "audio/mpeg": "mp3",
        "video/mp4": "mp4",
      };
      await reply("", {
        buffer: response.body,
        originalname: `attachment.${extensions[type] || "bin"}`,
        mimetype: type,
      });
    }
  } else if (kind === "push") {
    if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) return;
    const payload = {
      title:
        message.room_type === "Rooms::Direct"
          ? message.creator_name
          : message.room_name,
      options: {
        body:
          message.room_type === "Rooms::Direct"
            ? messagePlainText(message.id, body)
            : `${message.creator_name}: ${messagePlainText(message.id, body)}`,
        data: {
          path: `/rooms/${message.room_id}`,
          badge: get(
            "SELECT count(*) AS n FROM memberships WHERE user_id=? AND unread_at IS NOT NULL",
            data.user_id,
          ).n,
        },
      },
    };
    for (const subscription of all(
      "SELECT * FROM push_subscriptions WHERE user_id=?",
      data.user_id,
    )) {
      if (!permittedPushEndpoint(subscription.endpoint)) continue;
      let resolved;
      try {
        resolved = await resolvePublic(subscription.endpoint);
        if (resolved.url.protocol !== "https:") continue;
      } catch {
        continue;
      }
      const details = webpush.generateRequestDetails(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh_key,
            auth: subscription.auth_key,
          },
        },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: process.env.VAPID_SUBJECT || "mailto:campfire@example.com",
            publicKey: process.env.VAPID_PUBLIC_KEY,
            privateKey: process.env.VAPID_PRIVATE_KEY,
          },
        },
      );
      const response = await requestPinned(resolved.url, resolved.address, {
        method: details.method,
        headers: details.headers,
        body: details.body,
        maxBytes: 1024 * 1024,
      });
      if ([404, 410].includes(response.status))
        run("DELETE FROM push_subscriptions WHERE id=?", subscription.id);
      else if (response.status >= 400)
        throw new Error(`push HTTP ${response.status}`);
    }
  } else throw new Error(`unknown job ${kind}`);
}
export async function workOnce() {
  const job = claim();
  if (!job) return false;
  const heartbeat = setInterval(() => {
    try {
      prepared(
        "UPDATE jobs SET lease_until=? WHERE id=? AND lease_token=?",
      ).run(Date.now() / 1000 + 120, job.id, job.lease_token);
    } catch (error) {
      console.error("Campfire lease renewal failed:", error.message);
    }
  }, 30000);
  heartbeat.unref();
  try {
    const payload = JSON.parse(job.payload);
    await perform(payload.kind, payload.data);
    finish(job);
  } catch (error) {
    finish(job, error);
    console.error("Campfire job failed:", error.message);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
export function startWorker() {
  if (timer) return;
  stopping = false;
  timer = setInterval(async () => {
    if (working || stopping) return;
    working = true;
    try {
      // Drain the queue for up to ~20 ms per tick, yielding between jobs.
      const until = Date.now() + 20;
      while ((await workOnce()) && !stopping && Date.now() < until)
        await new Promise((resolve) => setImmediate(resolve));
    } catch (error) {
      console.error("Campfire queue failed:", error.message);
    } finally {
      working = false;
    }
  }, 250);
  timer.unref();
}
export async function stopWorker() {
  stopping = true;
  clearInterval(timer);
  timer = null;
  while (working) await new Promise((resolve) => setTimeout(resolve, 25));
}
