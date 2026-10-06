import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { all, get, run, transaction, now, onCommit } from "./db.js";
import {
  sanitize,
  plainText,
  mentionIds,
  reconcileEmbeds,
} from "./richtext.js";
import { publish } from "./cable.js";
import { stream } from "./rails.js";
import { fragment, messageData } from "./rendering.js";
import { enqueue, enqueueMany, permittedPushEndpoint } from "./jobs.js";
export const userById = (id) =>
  get("SELECT * FROM users WHERE id=?", Number(id));
export const roomsForUser = (id) =>
  all(
    "SELECT r.*,m.involvement,m.unread_at FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE m.user_id=? ORDER BY lower(r.name)",
    Number(id),
  );
export const roomForUser = (user, id) =>
  get(
    "SELECT r.* FROM rooms r JOIN memberships m ON m.room_id=r.id WHERE m.user_id=? AND r.id=?",
    Number(user?.id ?? user),
    Number(id),
  );
const presentation =
  "SELECT m.*,u.name AS creator_name,u.bio AS creator_bio,u.updated_at AS creator_updated_at,r.name AS room_name,r.type AS room_type,(SELECT updated_at FROM action_text_rich_texts WHERE record_type='Message' AND record_id=m.id AND name='body') AS body_updated_at,(SELECT max(blob_id) FROM active_storage_attachments WHERE record_type='Message' AND record_id=m.id AND name='attachment') AS attachment_blob_id FROM messages m JOIN users u ON u.id=m.creator_id JOIN rooms r ON r.id=m.room_id";
export const messageById = (id) =>
  get(presentation + " WHERE m.id=?", Number(id));
// Rows for the given ids, in the same order as ids (one query instead of N).
export function messagesByIds(ids) {
  if (!ids.length) return [];
  const byId = new Map();
  for (const row of all(
    presentation + " WHERE m.id IN (SELECT value FROM json_each(?))",
    JSON.stringify(ids.map(Number)),
  ))
    byId.set(row.id, row);
  return ids.map((id) => byId.get(Number(id)));
}
// Sanitized body of messages created in this process, so notifyMessage skips a re-read.
const createdContent = new WeakMap();
export function messagesForRoom(id, { before, after, around } = {}) {
  if (around) {
    const pivot = get(
      "SELECT * FROM messages WHERE id=? AND room_id=?",
      Number(around),
      Number(id),
    );
    if (!pivot) return messagesForRoom(id);
    return [
      ...all(
        presentation +
          " WHERE m.room_id=? AND m.created_at<? ORDER BY m.created_at DESC LIMIT 40",
        Number(id),
        pivot.created_at,
      ).reverse(),
      messageById(pivot.id),
      ...all(
        presentation +
          " WHERE m.room_id=? AND m.created_at>? ORDER BY m.created_at ASC LIMIT 40",
        Number(id),
        pivot.created_at,
      ),
    ];
  }
  let clauses = " WHERE m.room_id=?",
    args = [Number(id)];
  for (const [anchor, operator] of [
    [before, "<"],
    [after, ">"],
  ])
    if (anchor) {
      const pivot = get(
        "SELECT created_at FROM messages WHERE id=? AND room_id=?",
        Number(anchor),
        Number(id),
      );
      if (!pivot)
        throw Object.assign(new Error("Message not found"), { status: 404 });
      clauses += ` AND m.created_at${operator}?`;
      args.push(pivot.created_at);
    }
  const rows = all(
    presentation +
      clauses +
      ` ORDER BY m.created_at ${after ? "ASC" : "DESC"}, m.id ${after ? "ASC" : "DESC"} LIMIT 40`,
    ...args,
  );
  return after ? rows : rows.reverse();
}
export function grantMemberships(room, userIds) {
  const timestamp = now();
  for (const id of userIds)
    run(
      "INSERT OR IGNORE INTO memberships(room_id,user_id,involvement,created_at,updated_at) VALUES(?,?,?,?,?)",
      room.id,
      Number(id),
      room.type === "Rooms::Direct" ? "everything" : "mentions",
      timestamp,
      timestamp,
    );
}
export function createUser({
  name,
  email_address = null,
  password = "",
  role = 0,
  bot_token = null,
}) {
  if (!name?.trim() || (role !== 2 && (!email_address || !password)))
    throw Object.assign(new Error("Name, email and password required"), {
      status: 422,
    });
  return transaction(() => {
    const time = now();
    const result = run(
      "INSERT INTO users(name,email_address,password_digest,role,bot_token,status,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)",
      name,
      email_address,
      bcrypt.hashSync(password, 12),
      role,
      bot_token,
      time,
      time,
    );
    const user = userById(Number(result.lastInsertRowid));
    for (const room of all("SELECT * FROM rooms WHERE type='Rooms::Open'"))
      grantMemberships(room, [user.id]);
    return user;
  });
}
// Runs the deferred room/membership updates of a group commit, in post order.
export function applyUnread(list) {
  const rooms = new Map(),
    members = new Map();
  for (const u of list) {
    rooms.delete(u[0]);
    rooms.set(u[0], u);
    const k = u[0] + "|" + u[1];
    members.delete(k);
    members.set(k, u);
  }
  for (const [roomId, , time] of rooms.values())
    run("UPDATE rooms SET updated_at=? WHERE id=?", time, roomId);
  for (const [roomId, userId, time, cutoff] of members.values())
    run(
      "UPDATE memberships SET unread_at=?,updated_at=? WHERE room_id=? AND user_id<>? AND involvement<>'invisible' AND (connected_at IS NULL OR connected_at<?)",
      time,
      time,
      roomId,
      userId,
      cutoff,
    );
}
export function indexMessage(id, body, filename = "") {
  run("DELETE FROM message_search_index WHERE rowid=?", Number(id));
  run(
    "INSERT INTO message_search_index(rowid,body) VALUES(?,?)",
    Number(id),
    plainText(body) || filename,
  );
}
export function createMessage(
  roomId,
  userId,
  body = "",
  clientId = null,
  memberChecked = false,
  defer = null,
) {
  return transaction(() => {
    if (
      !memberChecked &&
      !get(
        "SELECT id FROM memberships WHERE room_id=? AND user_id=?",
        Number(roomId),
        Number(userId),
      )
    )
      throw Object.assign(new Error("Room membership required"), {
        status: 403,
      });
    const time = now(),
      content = sanitize(body);
    const result = run(
      "INSERT INTO messages(room_id,creator_id,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      Number(roomId),
      Number(userId),
      clientId || randomUUID(),
      time,
      time,
    );
    const id = Number(result.lastInsertRowid);
    const richId = Number(
      run(
        "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?)",
        id,
        content,
        time,
        time,
      ).lastInsertRowid,
    );
    // New AUTOINCREMENT ids: no old embeds or search row can exist for them.
    if (content.includes("<action-text-attachment"))
      reconcileEmbeds(richId, content, Number(userId));
    run(
      "INSERT INTO message_search_index(rowid,body) VALUES(?,?)",
      id,
      plainText(content) || "",
    );
    const cutoff = new Date(Date.now() - 60000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "");
    // A group commit runs these once per room / (room, creator) at the end:
    // the last post's statements write the same rows an earlier post's would.
    if (defer) defer.unread = [Number(roomId), Number(userId), time, cutoff];
    else {
    run("UPDATE rooms SET updated_at=? WHERE id=?", time, Number(roomId));
    run(
      "UPDATE memberships SET unread_at=?,updated_at=? WHERE room_id=? AND user_id<>? AND involvement<>'invisible' AND (connected_at IS NULL OR connected_at<?)",
      time,
      time,
      Number(roomId),
      Number(userId),
      cutoff,
    );
    }
    const message = messageById(id);
    createdContent.set(message, content);
    return message;
  });
}
export function updateMessage(
  message,
  body = null,
  userId = message.creator_id,
) {
  transaction(() => {
    const time = now();
    if (body !== null) {
      const content = sanitize(body);
      run(
        "INSERT INTO action_text_rich_texts(name,record_type,record_id,body,created_at,updated_at) VALUES('body','Message',?,?,?,?) ON CONFLICT(record_type,record_id,name) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
        message.id,
        content,
        time,
        time,
      );
      const obsolete = reconcileEmbeds(
        get(
          "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
          message.id,
        ).id,
        content,
        userId,
      );
      onCommit(() => {
        for (const blobId of obsolete) enqueue("purge", { blob_id: blobId });
      });
      const attachment = get(
        "SELECT b.filename FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='Message' AND a.record_id=? AND a.name='attachment'",
        message.id,
      );
      indexMessage(message.id, content, attachment?.filename || "");
    }
    run("UPDATE messages SET updated_at=? WHERE id=?", time, message.id);
    run("UPDATE rooms SET updated_at=? WHERE id=?", time, message.room_id);
  });
  return messageById(message.id);
}
export function deleteMessage(message, { broadcast = true } = {}) {
  if (typeof message === "number") message = messageById(message);
  if (!message) return;
  const richIds = all(
    "SELECT id FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
    message.id,
  ).map((r) => r.id);
  const blobIds = all(
    "SELECT blob_id FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
    message.id,
  ).map((a) => a.blob_id);
  for (const id of richIds)
    blobIds.push(
      ...all(
        "SELECT blob_id FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
        id,
      ).map((a) => a.blob_id),
    );
  transaction(() => {
    run("DELETE FROM boosts WHERE message_id=?", message.id);
    for (const id of richIds)
      run(
        "DELETE FROM active_storage_attachments WHERE record_type='ActionText::RichText' AND record_id=?",
        id,
      );
    run(
      "DELETE FROM active_storage_attachments WHERE record_type='Message' AND record_id=?",
      message.id,
    );
    run(
      "DELETE FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
      message.id,
    );
    run("DELETE FROM message_search_index WHERE rowid=?", message.id);
    run("DELETE FROM messages WHERE id=?", message.id);
    run("UPDATE rooms SET updated_at=? WHERE id=?", now(), message.room_id);
  });
  onCommit(() => {
    for (const id of blobIds) enqueue("purge", { blob_id: id });
    if (broadcast) publishMessage(message, "remove");
  });
}
export function publishMessage(
  message,
  action = "append",
  rendered = null,
  knownRoom = null,
  members = null,
) {
  const room =
    knownRoom || get("SELECT * FROM rooms WHERE id=?", message.room_id);
  if (!room) return;
  const target =
    action === "append"
      ? `messages_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}`
      : `message_${message.client_message_id}`;
  const html =
    action === "remove"
      ? ""
      : (rendered ??
        fragment("message", messageData([messageById(message.id)])[0]));
  publish(
    stream(room),
    `<turbo-stream action="${action}" target="${target}" maintain_scroll="true"><template>${html}</template></turbo-stream>`,
  );
  if (action === "append")
    for (const m of members ||
      all("SELECT user_id FROM memberships WHERE room_id=?", room.id))
      publish(`user_${m.user_id}_unreads`, { roomId: room.id });
}
// All memberships of a room with user role/status (null when the user row is missing).
export const roomMembers = (roomId) =>
  all(
    "SELECT m.*,u.role,u.status FROM memberships m LEFT JOIN users u ON u.id=m.user_id WHERE m.room_id=?",
    Number(roomId),
  );
// Publish a newly created message with pre-rendered html, then notify, sharing one memberships read.
export const createdBody = (message) => createdContent.get(message);
export const rememberCreated = (message, content) =>
  createdContent.set(message, content);
export function announceMessage(message, html, room) {
  const members = roomMembers(room.id);
  publishMessage(message, "append", html, room, members);
  notifyMessage(message, {}, room, members);
}
function pushableUsers(roomId) {
  const users = new Set();
  for (const s of all(
    "SELECT p.user_id,p.endpoint FROM push_subscriptions p JOIN memberships m ON m.user_id=p.user_id WHERE m.room_id=?",
    roomId,
  ))
    if (permittedPushEndpoint(s.endpoint)) users.add(s.user_id);
  return users;
}
export function notifyMessage(
  message,
  { webhooks = true } = {},
  knownRoom = null,
  members = null,
) {
  const content = createdContent.get(message);
  const body =
      content !== undefined
        ? content || ""
        : get(
            "SELECT body FROM action_text_rich_texts WHERE record_type='Message' AND record_id=?",
            message.id,
          )?.body || "",
    // Mentions are always <action-text-attachment> tags; skip the parse otherwise.
    mentions = body.includes("<action-text-attachment")
      ? mentionIds(body)
      : new Set(),
    room = knownRoom || get("SELECT * FROM rooms WHERE id=?", message.room_id);
  const jobs = [];
  // A push job only for users with a subscription Rails would deliver to.
  let pushable = null;
  for (const m of members ||
    all(
      "SELECT m.*,u.role,u.status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.room_id=? AND m.user_id<>?",
      message.room_id,
      message.creator_id,
    )) {
    if (m.user_id === message.creator_id || m.status !== 0) continue;
    if (
      webhooks &&
      m.role === 2 &&
      (room.type === "Rooms::Direct" || mentions.has(m.user_id))
    )
      for (const w of all("SELECT id FROM webhooks WHERE user_id=?", m.user_id))
        jobs.push(["webhook", { webhook_id: w.id, message_id: message.id }]);
    if (
      (pushable ??= pushableUsers(message.room_id)).has(m.user_id) &&
      (!m.connected_at ||
        Date.now() - Date.parse(m.connected_at + "Z") > 60000) &&
      (m.involvement === "everything" ||
        (m.involvement === "mentions" && mentions.has(m.user_id)))
    )
      jobs.push(["push", { user_id: m.user_id, message_id: message.id }]);
  }
  enqueueMany(jobs);
}
export function deleteRoom(room) {
  for (const message of all("SELECT * FROM messages WHERE room_id=?", room.id))
    deleteMessage(message);
  transaction(() => {
    run("DELETE FROM memberships WHERE room_id=?", room.id);
    run("DELETE FROM rooms WHERE id=?", room.id);
  });
  publish(
    "rooms",
    `<turbo-stream action="remove" target="list_rooms_${room.type.split("::").pop().toLowerCase()}_${room.id}"></turbo-stream>`,
  );
}
