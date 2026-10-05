import { availableParallelism } from "node:os";
// Imported first by server.js: db.js, jobs.js and cable.js read WEB_WORKERS at load time.
process.env.WEB_WORKERS ||= String(availableParallelism());
