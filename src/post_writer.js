import cluster from "node:cluster";
import { transaction, writeTransaction } from "./db.js";
import { stagedFiles } from "./storage.js";
import {
  createMessage,
  applyUnread,
  createdBody,
  rememberCreated,
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
function queueLocal(roomId, userId, body, clientId) {
  return new Promise((resolve, reject) => {
    postQueue.push({ roomId, userId, body, clientId, resolve, reject });
    if (!postFlushing) {
      postFlushing = true;
      setImmediate(flushPosts);
    }
  });
}
async function flushPosts() {
  try {
    while (postQueue.length) {
      let batch = null;
      try {
        await writeTransaction(() =>
          stagedFiles(() =>
            transaction(() => {
              batch = postQueue.splice(0);
              for (const p of batch)
                try {
                  p.message = createMessage(
                    p.roomId,
                    p.userId,
                    p.body,
                    p.clientId,
                    true,
                    p,
                  );
                } catch (error) {
                  p.error = error;
                }
              applyUnread(batch.filter((p) => !p.error).map((p) => p.unread));
            }),
          ),
        );
      } catch (error) {
        for (const p of batch || postQueue.splice(0)) p.reject(error);
        continue;
      }
      for (const p of batch) p.error ? p.reject(p.error) : p.resolve(p.message);
    }
  } finally {
    postFlushing = false;
  }
}
const clustered = Number(process.env.WEB_WORKERS || "1") > 1;
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
      rememberCreated(event.message, event.content);
      p.resolve(event.message);
    }
  });
if (clustered && cluster.isPrimary)
  cluster.on("message", (worker, event) => {
    if (event?.type !== "post") return;
    const reply = (m) => worker.isConnected() && worker.send(m);
    queueLocal(event.roomId, event.userId, event.body, event.clientId).then(
      (message) =>
        reply({
          type: "post-done",
          id: event.id,
          message,
          content: createdBody(message),
        }),
      (error) => {
        if (!(Number(error?.status) < 500)) console.error(error?.stack || error);
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
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ type: "post", id, roomId, userId, body, clientId });
  });
}
