import cluster from "node:cluster";
import { transaction, writeTransaction } from "./db.js";
import { stagedFiles } from "./storage.js";
import { sanitize, plainText } from "./richtext.js";
import {
  createMessage,
  applyUnread,
  rememberCreated,
  rememberAudience,
  roomAudience,
} from "./domain.js";
// Group commit: posts without attachments that arrive while the write lock is being
// acquired share one transaction (each in its own savepoint). Every response is
// sent only after the shared COMMIT.
//
// With several HTTP workers, workers send these posts to the primary process,
// which is the single writer for them: one connection with a warm page cache,
// no lock hand-offs between processes, and larger batches.
const postQueue = [];
let postFlushing = false;
function queueLocal(roomId, userId, body, clientId, content, plain) {
  return new Promise((resolve, reject) => {
    postQueue.push({
      roomId,
      userId,
      body,
      clientId,
      content,
      plain,
      resolve,
      reject,
    });
    if (!postFlushing) {
      postFlushing = true;
      setImmediate(flushPosts);
    }
  });
}
const create = (p) =>
  (p.message = createMessage(p.roomId, p.userId, p.body, p.clientId, true, p));
// Clustered primary: read each room's audience once per batch, inside the
// write transaction (warm cache), and send it with every reply.
const audienceOf = new WeakMap();
function audiences(batch) {
  if (!primaryWriter) return;
  const byRoom = new Map();
  for (const p of batch) {
    if (p.error || !p.message) continue;
    let a = byRoom.get(p.roomId);
    if (a === undefined) {
      try {
        a = roomAudience(p.roomId);
      } catch {
        a = null; // the worker reads it itself
      }
      byRoom.set(p.roomId, a);
    }
    if (a) audienceOf.set(p.message, a);
  }
}
async function flushPosts() {
  try {
    while (postQueue.length) {
      let batch = null;
      // Fast attempt: the whole batch without any savepoint. (Inside a savepoint
      // SQLite first copies every existing page it changes to a sub-journal
      // file, which made the memberships UPDATE ten times slower.)
      try {
        await writeTransaction(() =>
          stagedFiles(() => {
            batch = postQueue.splice(0);
            for (const p of batch) {
              p.bare = true;
              create(p);
            }
            applyUnread(batch.map((p) => p.unread));
            audiences(batch);
          }),
        );
      } catch {
        // Something failed and everything rolled back: redo the batch with one
        // savepoint per post so only the failing posts are rejected.
        if (batch)
          for (const p of batch) {
            p.bare = false;
            p.message = p.unread = undefined;
          }
        const retry = batch;
        try {
          await writeTransaction(() =>
            stagedFiles(() =>
              transaction(() => {
                batch = retry || postQueue.splice(0);
                for (const p of batch)
                  try {
                    create(p);
                  } catch (error) {
                    p.error = error;
                  }
                applyUnread(batch.filter((p) => !p.error).map((p) => p.unread));
                audiences(batch);
              }),
            ),
          );
        } catch (error) {
          for (const p of batch || postQueue.splice(0)) p.reject(error);
          continue;
        }
      }
      for (const p of batch) p.error ? p.reject(p.error) : p.resolve(p.message);
    }
  } finally {
    postFlushing = false;
  }
}
const clustered = Number(process.env.WEB_WORKERS || "1") > 1;
const primaryWriter = clustered && cluster.isPrimary;
const remote = clustered && cluster.isWorker;
const pending = new Map();
let seq = 0;
if (remote)
  process.on("message", (event) => {
    if (event?.type !== "post-done") return;
    const p = pending.get(event.id);
    if (!p) return;
    pending.delete(event.id);
    if (event.error)
      p.reject(
        Object.assign(
          new Error(event.error.message),
          event.error.status ? { status: event.error.status } : {},
        ),
      );
    else {
      rememberCreated(event.message, p.content);
      if (event.audience) rememberAudience(event.message, event.audience);
      p.resolve(event.message);
    }
  });
if (clustered && cluster.isPrimary)
  cluster.on("message", (worker, event) => {
    if (event?.type !== "post") return;
    const reply = (m) => worker.isConnected() && worker.send(m);
    queueLocal(
      event.roomId,
      event.userId,
      "",
      event.clientId,
      event.content,
      event.plain,
    ).then(
      (message) =>
        reply({
          type: "post-done",
          id: event.id,
          message,
          audience: audienceOf.get(message),
        }),
      (error) => {
        if (!(Number(error?.status) < 500))
          console.error(error?.stack || error);
        reply({
          type: "post-done",
          id: event.id,
          error: {
            message: String(error?.message || error),
            status: error?.status,
          },
        });
      },
    );
  });
export function queuePost(roomId, userId, body, clientId) {
  if (!remote) return queueLocal(roomId, userId, body, clientId);
  const content = sanitize(body),
    plain = plainText(content);
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, content });
    process.send({
      type: "post",
      id,
      roomId,
      userId,
      clientId,
      content,
      plain,
    });
  });
}
