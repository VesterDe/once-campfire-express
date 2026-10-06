import "./workers_env.js";
import cluster from "node:cluster";
import http from "node:http";
import { initialize } from "./db.js";
import { createApp, fastPath } from "./app.js";
import { attachCable, deliver } from "./cable.js";
import { startWorker, stopWorker } from "./jobs.js";
import "./post_writer.js";
import { postFastPath } from "./fast_post.js";
let shuttingDown = false;
const workers = Number(process.env.WEB_WORKERS || "1");
if (!Number.isInteger(workers) || workers < 1 || workers > 64)
  throw new Error("WEB_WORKERS must be between 1 and 64");
if (cluster.isPrimary) {
  initialize();
  await startWorker();
  if (workers > 1) {
    for (let i = 0; i < workers; i++) cluster.fork();
    cluster.on("exit", (worker, code, signal) => {
      if (!shuttingDown) {
        console.error(`HTTP worker exited (${code || signal}); restarting`);
        cluster.fork();
      }
    });
  }
}
if (workers === 1 || cluster.isWorker) {
  const app = createApp();
  const server = http.createServer((req, res) => {
    let done = false;
    try {
      done = fastPath(app, req, res) || postFastPath(app, req, res);
    } catch (error) {
      console.error(error);
    }
    if (!done) app(req, res);
  });
  attachCable(server);
  server.listen(
    Number(process.env.HTTP_PORT || 8080),
    process.env.BIND || "0.0.0.0",
    () =>
      console.log(
        `Campfire Express listening on ${process.env.HTTP_PORT || 8080}`,
      ),
  );
  const close = () => {
    server.close();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
if (cluster.isPrimary) {
  const close = async () => {
    shuttingDown = true;
    await stopWorker();
    for (const w of Object.values(cluster.workers || {})) w.disconnect();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
