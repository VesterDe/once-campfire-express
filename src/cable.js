import { WebSocketServer, WebSocket } from "ws";
import cluster from "node:cluster";
import { get, run, now, transaction } from "./db.js";
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
function alive(client) {
  return Boolean(
    get(
      "SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND u.status=0 AND u.role<>2",
      client.session_id,
      client.user_id,
    ),
  );
}
function authorize(client, identifier) {
  try {
    if (!alive(client)) return null;
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
export function deliver(stream, message) {
  for (const client of clients) {
    if (!alive(client)) {
      frame(client, {
        type: "disconnect",
        reason: "unauthorized",
        reconnect: false,
      });
      client.ws.close(1008);
      continue;
    }
    for (const [identifier, sub] of client.subscriptions) {
      if (sub.stream !== stream) continue;
      if (!authorize(client, identifier)) {
        client.subscriptions.delete(identifier);
        frame(client, { type: "reject_subscription", identifier });
        continue;
      }
      frame(client, { identifier, message });
    }
  }
}
export function publish(stream, message) {
  if (cluster.isWorker) process.send?.({ type: "cable", stream, message });
  else {
    deliver(stream, message);
    for (const worker of Object.values(cluster.workers || {}))
      worker.send({ type: "cable", stream, message });
  }
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
            frame(client, { type: "confirm_subscription", identifier });
          } else if (msg.command === "unsubscribe") {
            const sub = client.subscriptions.get(identifier);
            if (sub?.channel === "PresenceChannel" && sub.present)
              presence(client.user_id, sub.room, "absent");
            client.subscriptions.delete(identifier);
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
        for (const sub of client.subscriptions.values())
          if (sub.channel === "PresenceChannel" && sub.present)
            presence(client.user_id, sub.room, "absent");
      });
    });
  });
  const ping = setInterval(() => {
    for (const client of clients) {
      if (!alive(client)) {
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
  if (cluster.isWorker)
    process.on("message", (event) => {
      if (event?.type === "cable") deliver(event.stream, event.message);
    });
  return wss;
}
