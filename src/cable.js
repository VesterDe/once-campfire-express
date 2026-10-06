import { WebSocketServer, WebSocket } from "ws";
import cluster from "node:cluster";
import { get, run, now, transaction, epoch } from "./db.js";
import * as rails from "./rails.js";
// Keep the socket module independent from the HTTP router to avoid import cycles.
function identity(header = "") {
  try {
    const part = header
      .split(";")
      .find((p) => p.trim().startsWith("session_token="));
    if (!part) return null;
    const raw = part.trim().slice("session_token=".length),
      token = rails.verifyCookie("session_token", raw);
    return get(
      "SELECT s.id AS session_id,u.id AS user_id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status=0 AND u.role<>2",
      token,
    );
  } catch {
    return null;
  }
}
const clients = new Set();
// stream -> clients with at least one subscription to it
const byStream = new Map();
function index(client, stream) {
  let set = byStream.get(stream);
  if (!set) byStream.set(stream, (set = new Set()));
  set.add(client);
}
function unindex(client, stream) {
  for (const sub of client.subscriptions.values())
    if (sub.stream === stream) return;
  const set = byStream.get(stream);
  if (set && set.delete(client) && !set.size) byStream.delete(stream);
}
// Session and subscription checks are cached until the database changes (any process).
function alive(client, e = epoch()) {
  if (e !== -1 && client.aliveAt === e) return true;
  const ok = Boolean(
    get(
      "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND u.status=0 AND u.role<>2",
      client.session_id,
      client.user_id,
    ),
  );
  client.aliveAt = ok ? e : 0;
  return ok;
}
function authorize(client, identifier, e = epoch()) {
  try {
    if (!alive(client, e)) return null;
    const p = JSON.parse(identifier);
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const channel = p.channel;
    let room = 0,
      stream = "";
    if (["ApplicationCable::Channel", "HeartbeatChannel"].includes(channel)) {
    } else if (["ReadRoomsChannel", "UnreadRoomsChannel"].includes(channel))
      stream = `user_${client.user_id}_${channel === "ReadRoomsChannel" ? "reads" : "unreads"}`;
    else if (channel === "RoomMessagesChannel") {
      stream = rails.verifyStream(p.signed_stream_name);
      if (typeof stream !== "string") return null;
      const [encoded, suffix, ...rest] = stream.split(":");
      if (suffix !== "messages" || rest.length) return null;
      const m = rails
        .decode64(encoded)
        .toString()
        .match(
          /^gid:\/\/campfire\/(Room|Rooms::Open|Rooms::Closed|Rooms::Direct)\/(\d+)$/,
        );
      if (!m) return null;
      room = Number(m[2]);
      const r = get(
        "SELECT r.* FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE r.id=? AND m.user_id=?",
        room,
        client.user_id,
      );
      if (!r || !["Room", r.type].includes(m[1])) return null;
    } else if (
      ["RoomChannel", "PresenceChannel", "TypingNotificationsChannel"].includes(
        channel,
      )
    ) {
      room = Number(p.room_id);
      if (
        !Number.isSafeInteger(room) ||
        !get(
          "SELECT id FROM memberships WHERE room_id=? AND user_id=?",
          room,
          client.user_id,
        )
      )
        return null;
      stream = channel + ":" + room;
    } else if (channel === "Turbo::StreamsChannel") {
      stream = rails.verifyStream(p.signed_stream_name);
      const own =
        Buffer.from(`gid://campfire/User/${client.user_id}`)
          .toString("base64")
          .replace(/=+$/, "") + ":rooms";
      if (!["rooms", own].includes(stream)) return null;
    } else return null;
    return { channel, room, stream };
  } catch {
    return null;
  }
}
function frame(client, value) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > 1024 * 1024) {
    client.ws.close(1013, "slow consumer");
    return;
  }
  client.ws.send(JSON.stringify(value));
}
function unauthorized(client) {
  frame(client, {
    type: "disconnect",
    reason: "unauthorized",
    reconnect: false,
  });
  client.ws.close(1008);
}
// Delivers [stream, message] pairs in order. Each payload is encoded once per identifier.
function deliverAll(items) {
  if (!clients.size) return;
  const e = epoch(),
    corked = items.length > 1 ? new Set() : null;
  for (const [stream, message] of items) {
    const set = byStream.get(stream);
    if (!set) continue;
    let json, encoded;
    for (const client of [...set]) {
      const ws = client.ws;
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!alive(client, e)) {
        unauthorized(client);
        continue;
      }
      for (const [identifier, sub] of client.subscriptions) {
        if (sub.stream !== stream) continue;
        if (e === -1 || sub.authAt !== e) {
          if (!authorize(client, identifier, e)) {
            client.subscriptions.delete(identifier);
            unindex(client, stream);
            frame(client, { type: "reject_subscription", identifier });
            continue;
          }
          sub.authAt = e;
        }
        if (ws.bufferedAmount > 1024 * 1024) {
          ws.close(1013, "slow consumer");
          break;
        }
        json ??= JSON.stringify(message);
        encoded ??= new Map();
        let buffer = encoded.get(identifier);
        if (!buffer)
          encoded.set(
            identifier,
            (buffer = Buffer.from(
              (sub.head ??=
                '{"identifier":' + JSON.stringify(identifier) + ',"message":') +
                json +
                "}",
            )),
          );
        if (corked && !corked.has(ws)) {
          corked.add(ws);
          ws._socket?.cork();
        }
        ws.send(buffer, { binary: false });
      }
    }
  }
  if (corked) for (const ws of corked) ws._socket?.uncork();
}
export function deliver(stream, message) {
  deliverAll([[stream, message]]);
}
// Cluster fan-out. The primary is the single sequencer, so every socket sees one order
// of publications. Publications from one tick go as one IPC batch. Nothing is sent
// while no worker has sockets, and the primary forwards only to workers with sockets.
const clustered =
  cluster.isWorker ||
  (cluster.isPrimary && Number(process.env.WEB_WORKERS || "1") > 1);
let outbox = null,
  any = true, // worker: does some worker have sockets? (safe until the primary says)
  ready = true, // worker: every peer knows that we have sockets
  readyId = 0;
const waiting = [];
function flush() {
  const event = { type: "cable-batch", items: outbox };
  outbox = null;
  if (cluster.isWorker) process.send?.(event);
  else forward(event);
}
// False when publish() would drop everything (no socket anywhere it could reach).
export function publishable() {
  if (!clustered) return clients.size > 0;
  return cluster.isWorker ? any || clients.size > 0 : has.size > 0;
}
export function publish(stream, message) {
  if (!clustered) return deliver(stream, message);
  if (cluster.isWorker ? !any && !clients.size : !has.size) return;
  if (!outbox) {
    outbox = [];
    queueMicrotask(flush);
  }
  outbox.push([stream, message]);
}
// A worker that gains its first socket holds subscription confirmations until the
// primary reports that every other worker has started forwarding publications.
function confirm(client, identifier) {
  if (ready) frame(client, { type: "confirm_subscription", identifier });
  else waiting.push([client, identifier]);
}
function announce() {
  if (!cluster.isWorker) return;
  const on = clients.size > 0;
  if (on) ready = false;
  process.send?.({ type: "cable-clients", on, id: ++readyId });
}
function onWorkerMessage(event) {
  if (event?.type === "cable-batch") deliverAll(event.items);
  else if (event?.type === "cable") deliver(event.stream, event.message);
  else if (event?.type === "cable-any") {
    any = event.any;
    if (event.ack) process.send?.({ type: "cable-ack", ack: event.ack });
  } else if (event?.type === "cable-ready" && event.id === readyId) {
    ready = true;
    for (const [client, identifier] of waiting.splice(0))
      if (client.subscriptions.has(identifier)) confirm(client, identifier);
  }
}
// Primary side.
const has = new Set(), // ids of workers with sockets
  pendingAcks = new Map(); // ack id -> { left: Set(worker id), done: [fn] }
let ackSeq = 0;
function forward(event) {
  for (const id of has) {
    const w = cluster.workers?.[id];
    if (w?.isConnected()) w.send(event);
  }
}
function settle(ack) {
  const entry = pendingAcks.get(ack);
  if (!entry) return;
  pendingAcks.delete(ack);
  clearTimeout(entry.timer);
  for (const fn of entry.done) fn();
}
function onPrimaryMessage(worker, event) {
  if (event?.type === "cable-batch") {
    if (has.size) forward(event);
  } else if (event?.type === "cable-clients") {
    const before = has.size > 0;
    if (event.on) has.add(worker.id);
    else has.delete(worker.id);
    const after = has.size > 0;
    const reply = () => {
      if (event.on && worker.isConnected())
        worker.send({ type: "cable-ready", id: event.id });
    };
    worker.send({ type: "cable-any", any: after });
    const others = Object.values(cluster.workers || {}).filter(
      (w) => w !== worker && w.isConnected(),
    );
    if (before === after) {
      // Wait for any round that is still telling peers to forward.
      const last = [...pendingAcks.values()].at(-1);
      if (last) last.done.push(reply);
      else reply();
    } else if (!after) {
      for (const w of others) w.send({ type: "cable-any", any: false });
    } else {
      const ack = ++ackSeq,
        entry = { left: new Set(others.map((w) => w.id)), done: [reply] };
      pendingAcks.set(ack, entry);
      for (const w of others) w.send({ type: "cable-any", any: true, ack });
      entry.timer = setTimeout(() => settle(ack), 2000);
      entry.timer.unref();
      if (!entry.left.size) settle(ack);
    }
  } else if (event?.type === "cable-ack") {
    const entry = pendingAcks.get(event.ack);
    if (entry) {
      entry.left.delete(worker.id);
      if (!entry.left.size) settle(event.ack);
    }
  }
}
if (cluster.isPrimary && clustered) {
  cluster.on("message", onPrimaryMessage);
  cluster.on("exit", (worker) => {
    const was = has.size > 0;
    has.delete(worker.id);
    for (const [ack, entry] of pendingAcks) {
      entry.left.delete(worker.id);
      if (!entry.left.size) settle(ack);
    }
    if (was && !has.size)
      for (const w of Object.values(cluster.workers || {}))
        if (w.isConnected()) w.send({ type: "cable-any", any: false });
  });
}
function presence(user, room, action) {
  transaction(() => {
    const m = get(
      "SELECT * FROM memberships WHERE user_id=? AND room_id=?",
      user,
      room,
    );
    if (!m) return;
    const active =
      m.connected_at &&
      new Date(m.connected_at.replace(" ", "T") + "Z").getTime() >=
        Date.now() - 60000;
    if (["present", "refresh"].includes(action)) {
      const count = active
        ? action === "present"
          ? Number(m.connections) + 1
          : Number(m.connections)
        : 1;
      run(
        "UPDATE memberships SET connections=?,connected_at=?,unread_at=NULL,updated_at=? WHERE id=?",
        count,
        now(),
        now(),
        m.id,
      );
    } else {
      const count = active ? Math.max(0, Number(m.connections) - 1) : 0;
      run(
        "UPDATE memberships SET connections=?,connected_at=?,updated_at=? WHERE id=?",
        count,
        count ? m.connected_at : null,
        now(),
        m.id,
      );
    }
  });
  if (action === "present") publish(`user_${user}_reads`, { room_id: room });
}
export function attachCable(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    handleProtocols: (protocols) =>
      protocols.has("actioncable-v1-json") ? "actioncable-v1-json" : false,
  });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname !== "/cable") {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "");
    const trusted = (process.env.TRUSTED_PROXIES || "")
      .split(",")
      .includes(remote);
    const forwarded = trusted && req.headers["x-forwarded-proto"];
    const protocol = forwarded === "https" ? "https" : "http";
    if (origin && origin !== protocol + "://" + req.headers.host) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const id = identity(req.headers.cookie);
    if (
      !id ||
      !req.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((s) => s.trim())
        .includes("actioncable-v1-json")
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ...id, ws, subscriptions: new Map() };
      clients.add(client);
      if (clients.size === 1) announce();
      frame(client, { type: "welcome" });
      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          ws.close(1003);
          return;
        }
        try {
          const msg = JSON.parse(raw.toString());
          const identifier = msg.identifier;
          if (typeof identifier !== "string" || identifier.length > 8192)
            return ws.close(1008);
          if (msg.command === "subscribe") {
            if (
              client.subscriptions.size >= 32 &&
              !client.subscriptions.has(identifier)
            )
              return ws.close(1008);
            const sub = authorize(client, identifier);
            if (!sub) {
              frame(client, { type: "reject_subscription", identifier });
              return;
            }
            if (sub.channel === "PresenceChannel") {
              const existing = client.subscriptions.get(identifier);
              sub.present = existing ? existing.present : true;
              if (!existing) presence(client.user_id, sub.room, "present");
            }
            client.subscriptions.set(identifier, sub);
            index(client, sub.stream);
            confirm(client, identifier);
          } else if (msg.command === "unsubscribe") {
            const sub = client.subscriptions.get(identifier);
            if (sub?.channel === "PresenceChannel" && sub.present)
              presence(client.user_id, sub.room, "absent");
            client.subscriptions.delete(identifier);
            if (sub) unindex(client, sub.stream);
          } else if (
            msg.command === "message" &&
            client.subscriptions.has(identifier)
          ) {
            const sub = authorize(client, identifier);
            if (!sub) return;
            const body = JSON.parse(msg.data);
            if (sub.channel === "PresenceChannel") {
              const stored = client.subscriptions.get(identifier);
              if (body.action === "refresh" && stored.present)
                presence(client.user_id, sub.room, "refresh");
              else if (body.action === "absent" && stored.present) {
                presence(client.user_id, sub.room, "absent");
                stored.present = false;
              } else if (body.action === "present" && !stored.present) {
                presence(client.user_id, sub.room, "present");
                stored.present = true;
              }
            } else if (
              sub.channel === "TypingNotificationsChannel" &&
              ["start", "stop"].includes(body.action)
            )
              publish(sub.stream, {
                action: body.action,
                user: { id: client.user_id, name: client.name },
              });
          }
        } catch {
          ws.close(1008);
        }
      });
      ws.on("close", () => {
        clients.delete(client);
        for (const sub of client.subscriptions.values()) {
          const set = byStream.get(sub.stream);
          if (set && set.delete(client) && !set.size)
            byStream.delete(sub.stream);
        }
        if (!clients.size) announce();
        for (const sub of client.subscriptions.values())
          if (sub.channel === "PresenceChannel" && sub.present)
            presence(client.user_id, sub.room, "absent");
      });
    });
  });
  const ping = setInterval(() => {
    const e = epoch();
    for (const client of clients) {
      if (!alive(client, e)) {
        frame(client, {
          type: "disconnect",
          reason: "unauthorized",
          reconnect: false,
        });
        client.ws.close(1008);
      } else
        frame(client, { type: "ping", message: Math.floor(Date.now() / 1000) });
    }
  }, 3000);
  ping.unref();
  server.on("close", () => {
    clearInterval(ping);
    for (const c of clients) c.ws.terminate();
    wss.close();
  });
  if (cluster.isWorker) {
    process.on("message", onWorkerMessage);
    announce();
  }
  return wss;
}
