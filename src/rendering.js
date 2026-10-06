import nunjucks from "nunjucks";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import zlib from "node:zlib";
import { all, get, epoch as dbEpoch } from "./db.js";
import * as rails from "./rails.js";
import { escape, plainText, renderBody } from "./richtext.js";
import { blobUrl, representationUrl } from "./storage.js";
import { fast, message as fastMessage } from "./fast_templates.js";
const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(
    new URL("../templates/", import.meta.url).pathname,
  ),
  { autoescape: true },
);
const safe = (value) => new nunjucks.runtime.SafeString(value || "");
const generatedMemo = new Map();
function generated(name, fallback = "") {
  const k = name + "\0" + fallback;
  let v = generatedMemo.get(k);
  if (v === undefined) {
    const path = new URL(`../assets/generated/${name}`, import.meta.url);
    v = existsSync(path) ? readFileSync(path, "utf8") : fallback;
    generatedMemo.set(k, v);
  }
  return v;
}
let manifest;
export function asset(name) {
  manifest ||= JSON.parse(generated("manifest.json", "{}"));
  return "/assets/" + (manifest[name]?.digested_path || name);
}
export function epoch(value) {
  return value
    ? new Date(
        String(value).replace(" ", "T") +
          (String(value).endsWith("Z") ? "" : "Z"),
      ).getTime() || 0
    : 0;
}
export function iso(value) {
  return new Date(epoch(value)).toISOString();
}
// Signed ids depend on SECRET_KEY_BASE too, so it is part of every memo key.
const avatarMemo = new Map();
export function avatar(id, updated) {
  const k = id + "|" + updated + "|" + process.env.SECRET_KEY_BASE;
  let v = avatarMemo.get(k);
  if (v === undefined) {
    v =
      `/users/${rails.signedId("User", Number(id), "avatar")}/avatar` +
      (updated ? "?v=" + versionTime(updated) : "");
    if (avatarMemo.size >= 10000) avatarMemo.clear();
    avatarMemo.set(k, v);
  }
  return v;
}
const streamMemo = new Map();
export function signStream(name) {
  const k = name + "|" + process.env.SECRET_KEY_BASE;
  let v = streamMemo.get(k);
  if (v === undefined) {
    v = rails.signStream(name);
    if (streamMemo.size >= 10000) streamMemo.clear();
    streamMemo.set(k, v);
  }
  return v;
}
export function versionTime(value) {
  return new Date(epoch(value))
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
}
export function userData(user) {
  if (!user) return { ID: 0, Role: 0, Name: "" };
  return {
    ID: user.id,
    Role: user.role,
    Name: user.name,
    Email: user.email_address || "",
    Bio: user.bio || "",
    UpdatedAt: user.updated_at,
    Title: [user.name, user.bio].filter(Boolean).join(" – "),
    Status: user.status,
    BotKey: `${user.id}-${user.bot_token}`,
    Administer: user.role === 1,
  };
}
// Members of many direct rooms in one query; same order as roomData's own query.
export function directMembers(roomIds) {
  const map = new Map();
  if (!roomIds.length) return map;
  for (const id of roomIds) map.set(id, []);
  for (const u of all(
    `SELECT m.room_id AS member_room_id,u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.room_id IN (${roomIds.map(() => "?").join(",")}) ORDER BY u.name`,
    ...roomIds,
  )) {
    const list = map.get(u.member_room_id);
    delete u.member_room_id;
    list.push(u);
  }
  return map;
}
export function roomData(room, user, membersByRoom = null) {
  const kind = (room.type || "Rooms::Open").split("::").pop().toLowerCase();
  const members =
    kind === "direct"
      ? (
          membersByRoom?.get(room.id) ||
          all(
            "SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.room_id=? ORDER BY u.name",
            room.id,
          )
        ).filter((u) => u.id !== user?.id)
      : [];
  return {
    ID: room.id || 0,
    Name:
      kind === "direct"
        ? members.map((u) => u.name).join(", ")
        : room.name || "",
    Type: room.type,
    UpdatedAt: room.updated_at,
    CreatorID: room.creator_id,
    DOM: (prefix) => `${prefix}_rooms_${kind}_${room.id}`,
    Noun: kind === "direct" ? "ping" : "room",
    EditPath: `/rooms/${kind}s/${room.id}/edit`,
    Members: members.map(userData),
    Label: members.map((u) => u.name.split(" ")[0]).join(", "),
  };
}
export function messageData(messages, origin = "", fresh = null) {
  if (!messages.length) return [];
  const ids = messages.map((m) => m.id),
    placeholders = ids.map(() => "?").join(",");
  // fresh: body of a message this request just created without attachment
  // (so no blob or boost rows exist for it yet).
  const bodies =
    fresh !== null
      ? new Map([[ids[0], fresh || ""]])
      : new Map(
          all(
            `SELECT record_id,body FROM action_text_rich_texts WHERE record_type='Message' AND name='body' AND record_id IN (${placeholders})`,
            ...ids,
          ).map((r) => [r.record_id, r.body || ""]),
        );
  const blobs =
    fresh !== null
      ? new Map()
      : new Map(
          all(
            `SELECT a.record_id,b.* FROM active_storage_attachments a JOIN active_storage_blobs b ON b.id=a.blob_id WHERE a.record_type='Message' AND a.name='attachment' AND a.record_id IN (${placeholders})`,
            ...ids,
          ).map((r) => [r.record_id, r]),
        );
  const boosts =
    fresh !== null
      ? []
      : all(
          `SELECT b.*,u.name,u.bio,u.updated_at AS booster_updated_at FROM boosts b JOIN users u ON u.id=b.booster_id WHERE b.message_id IN (${placeholders}) ORDER BY b.created_at`,
          ...ids,
        );
  const boostsByMessage = new Map();
  for (const b of boosts) {
    let list = boostsByMessage.get(b.message_id);
    if (!list) boostsByMessage.set(b.message_id, (list = []));
    list.push(b);
  }
  return messages.map((m) => {
    const blob = blobs.get(m.id);
    const text = plainText(bodies.get(m.id));
    let body = renderBody(bodies.get(m.id) || "");
    let url = "";
    if (blob) {
      url = blobUrl(blob);
      const name = escape(blob.filename);
      if (
        (blob.content_type || "").startsWith("image/") ||
        blob.content_type === "application/pdf"
      )
        body = `<a href="${url}" data-lightbox-target="image" data-action="lightbox#open" data-lightbox-url-value="${url}?disposition=attachment"><img class="message__attachment" src="${representationUrl(blob)}" alt="${name}" loading="lazy"></a>`;
      else if ((blob.content_type || "").startsWith("video/"))
        body = `<video src="${url}" poster="${representationUrl(blob)}" controls class="message__attachment"></video>`;
      else body = `<a href="${url}?disposition=attachment">${name}</a>`;
    }
    return {
      ID: m.id,
      ClientID: m.client_message_id,
      CreatorID: m.creator_id,
      Creator:
        m.creator_name ||
        get("SELECT name FROM users WHERE id=?", m.creator_id)?.name,
      CreatorTitle: m.creator_name,
      CreatorUpdatedAt: m.creator_updated_at,
      RoomID: m.room_id,
      RoomName: m.room_name || "",
      CreatedAt: m.created_at,
      UpdatedAt: m.updated_at,
      HTML: safe('<div class="lexxy-content">' + body + "</div>"),
      AllEmoji: !!text && !/[\p{L}\p{N}]/u.test(text),
      Boosts: (boostsByMessage.get(m.id) || []).map((b) => ({
        ID: b.id,
        MessageID: b.message_id,
        BoosterID: b.booster_id,
        Booster: b.name,
        BoosterTitle: b.name,
        BoosterUpdatedAt: b.booster_updated_at,
        Content: b.content,
      })),
      Attachment: blob ? { Filename: blob.filename } : null,
      DownloadURL: url ? url + "?disposition=attachment" : "",
      BlobURL: url,
      Permalink: `${origin}/rooms/${m.room_id}/@${m.id}`,
    };
  });
}
const translations = JSON.parse(
  readFileSync(new URL("./translations.json", import.meta.url)),
);
const reactions = [
  ["👍", "Thumbs up"],
  ["👏", "Clapping"],
  ["👋", "Waving hand"],
  ["💪", "Muscle"],
  ["❤️", "Red heart"],
  ["😂", "Face with tears of joy"],
  ["🎉", "Party popper"],
  ["🔥", "Fire"],
];
for (const [name, fn] of Object.entries({
  asset,
  avatar,
  epoch,
  iso,
  versionTime,
  len: (x) => x?.length || 0,
  get: (x, k) => x?.[k] || false,
  firstName: (s) => (s || "").split(" ")[0],
  lower: (s) => (s || "").toLowerCase(),
  stylesheets: () => safe(generated("stylesheets.html")),
  importmap: () => safe(generated("importmap.html")),
  printf: (fmt, ...args) => fmt.replace(/%[sd]/g, () => args.shift()),
  allEmoji: (s) => !!s && !/[\p{L}\p{N}]/u.test(s),
  qrpath: (s) => "/qr_code/" + Buffer.from(s).toString("base64url"),
  humanInvolvement: (s) =>
    ({
      everything: "Notifying about all messages",
      mentions: "Notifying about @ mentions",
      nothing: "Notifications are off",
      invisible: "Notifications are off and room invisible in sidebar",
    })[s] || "",
  nextInvolvement: (kind, v) => {
    const choices =
      kind === "Rooms::Direct"
        ? ["everything", "nothing"]
        : ["mentions", "everything", "nothing", "invisible"];
    return choices[(choices.indexOf(v) + 1) % choices.length];
  },
  reactions: () =>
    reactions.map(([Character, Title]) => ({ Character, Title })),
  agent: (s) => ({ Name: s, Platform: "", Browser: s }),
  helpMailto: (u) => safe(`href="mailto:${escape(u.Email)}"`),
  botCommand: (origin, room, key) =>
    `curl -d 'Hello!' ${origin}/rooms/${room}/${key}/messages`,
  translate: (key) =>
    safe(
      '<details class="position-relative" data-controller="popup"><summary class="btn"><img width="20" height="20" src="' +
        asset("globe.svg") +
        '"><span class="for-screen-reader">Translate</span></summary><dl>' +
        (translations[key] || [])
          .map(
            ([flag, text]) =>
              `<dt>${escape(flag)}</dt><dd>${escape(text)}</dd>`,
          )
          .join("") +
        "</dl></details>",
    ),
}))
  env.addGlobal(name, fn);
let exported;
function macros() {
  if (!exported)
    env.getTemplate("pages.html", true).getExported((error, result) => {
      if (error) throw error;
      exported = result;
    });
  return exported;
}
// Every per-message HTML render goes through this one function.
export function renderMessageHTML(dot) {
  return fastMessage(dot);
}
export function fragment(name, data = {}) {
  if (name === "message") return renderMessageHTML(data);
  const f = fast[name];
  if (f) return f(data);
  return String(macros()[name.replaceAll("-", "_")](data));
}
function pageData(req, screen, extra) {
  const account = get("SELECT * FROM accounts LIMIT 1");
  let settings = {};
  try {
    settings = JSON.parse(account?.settings || "{}");
  } catch {}
  const Account = account
    ? {
        ID: account.id,
        Name: account.name,
        JoinCode: account.join_code,
        UpdatedAt: account.updated_at,
        HasLogo: !!get(
          "SELECT id FROM active_storage_attachments WHERE record_type='Account' AND record_id=? AND name='logo'",
          account.id,
        ),
        RestrictRooms: !!settings.restrict_room_creation_to_administrators,
        RestrictRoomCreation:
          !!settings.restrict_room_creation_to_administrators,
      }
    : {};
  return {
    User: userData(req.user),
    Account,
    Screen: screen,
    BodyClass:
      screen === "search"
        ? "sidebar searches"
        : ["room", "welcome"].includes(screen)
          ? "sidebar"
          : screen,
    Title: "Campfire",
    Frame: !!req.get?.("Turbo-Frame"),
    Origin: `${req.protocol || "http"}://${req.get?.("host") || "localhost"}`,
    CSRF: req.csrfToken || "",
    Version: "once-campfire-express",
    VAPIDPublicKey: process.env.VAPID_PUBLIC_KEY || "",
    CustomStyles: safe(
      account?.custom_styles ? `<style>${account.custom_styles}</style>` : "",
    ),
    Messages: [],
    RecentSearches: [],
    RoomsStream: signStream("rooms"),
    UserRoomsStream: req.user
      ? signStream(
          Buffer.from(`gid://campfire/User/${req.user.id}`)
            .toString("base64")
            .replace(/=+$/, "") + ":rooms",
        )
      : "",
    CanCreateRooms: req.user?.role === 1 || !Account.RestrictRooms,
    Notice: "",
    Error: "",
    Reload: false,
    Chat: screen === "room",
    ReturnRoom: req.session?.last_room_id || "",
    Query: "",
    ...extra,
  };
}
const FORM_RE = /(<form\b[^>]*\bmethod="post"[^>]*>)/gi;
function withCsrf(html, csrf) {
  html = html.replace(
    "</head>",
    `<meta name="csrf-param" content="authenticity_token"><meta name="csrf-token" content="${csrf}"></head>`,
  );
  return html.replace(
    FORM_RE,
    `$1<input type="hidden" name="authenticity_token" value="${csrf}">`,
  );
}
export function render(req, screen, extra = {}) {
  return withCsrf(
    fragment(screen, pageData(req, screen, extra)),
    escape(req.csrfToken || ""),
  );
}

// ---- Message fragment cache ----------------------------------------------
// Rendered message HTML is kept per message (dropped whenever db epoch()
// moves; routes call cacheEpoch() before they read the rows and pass that
// value in). Pages themselves are rendered for every request. A page is a
// list of pieces with this request's CSRF token between them. Each piece
// has its own raw-deflate stream (ended with Z_SYNC_FLUSH; message pieces
// keep theirs in the cache), so a gzip response is the pieces joined with
// the token as stored blocks, one final empty block, and the CRC/length trailer.
const TOKEN_MARK = "\u0000" + randomUUID() + "\u0002";
const MESSAGES_MARK = "\u0000" + randomUUID() + "\u0001";
const MESSAGE_CAP = 5000;
const messageCache = new Map();
let currentEpoch = null;
export function cacheEpoch() {
  const e = dbEpoch();
  if (e !== currentEpoch) {
    messageCache.clear();
    rowsCache.clear();
    layoutPieces.clear();
    entriesByRows = new WeakMap();
    currentEpoch = e;
  }
  return e;
}
// Message rows for one room query (see domain.js messagesForRoom), kept until
// the epoch moves. The epoch is read before the query, so a stored list is
// never older than the epoch it is filed under. Lists and rows are frozen.
const ROWS_CAP = 200;
const rowsCache = new Map();
export function cachedRows(key, fn) {
  const ep = cacheEpoch();
  if (ep === -1 || ep == null) return fn();
  let rows = rowsCache.get(key);
  if (rows) return rows;
  rows = fn();
  for (const r of rows) Object.freeze(r);
  Object.freeze(rows);
  if (cacheEpoch() === ep) {
    rowsCache.set(key, rows);
    if (rowsCache.size > ROWS_CAP)
      rowsCache.delete(rowsCache.keys().next().value);
  }
  return rows;
}
// Entries made for a cached (frozen) row list, per origin.
let entriesByRows = new WeakMap();
// Layout pieces by their exact text: the deflate stream and CRC of a layout
// piece are made once and reused while the same text comes back.
const LAYOUT_CAP = 300;
const layoutPieces = new Map();
function layoutPiece(text) {
  let p = layoutPieces.get(text);
  if (p) return p;
  p = piece(text, 1);
  layoutPieces.set(text, p);
  if (layoutPieces.size > LAYOUT_CAP)
    layoutPieces.delete(layoutPieces.keys().next().value);
  return p;
}
const usable = (ep) => ep !== -1 && ep != null && cacheEpoch() === ep;
const SYNC6 = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
const SYNC1 = { level: 1, finishFlush: zlib.constants.Z_SYNC_FLUSH };
function piece(text, level) {
  return { raw: Buffer.from(text), z: null, level, crc: -1, shift: null };
}
// CRC-32 of the joined pieces by zlib's crc32_combine: each piece keeps its
// own CRC and x^(8*length) mod P, so a request does one multiply per piece
// instead of a CRC pass over the whole page.
function gfMul(a, b) {
  if (!a) return 0;
  let m = 0x80000000,
    p = 0;
  for (;;) {
    if (a & m) {
      p ^= b;
      if ((a & (m - 1)) === 0) break;
    }
    m >>>= 1;
    b = b & 1 ? (b >>> 1) ^ 0xedb88320 : b >>> 1;
  }
  return p >>> 0;
}
const POW2 = [0x40000000];
for (let i = 1; i < 32; i++) POW2.push(gfMul(POW2[i - 1], POW2[i - 1]));
function byteShift(n) {
  let p = 0x80000000,
    k = 3;
  while (n) {
    if (n & 1) p = gfMul(POW2[k & 31], p);
    n = Math.floor(n / 2);
    k++;
  }
  return p >>> 0;
}
// Multiplying by x^(8*n) is linear, so it is kept as 8 tables of 16 values
// (one per 4-bit group of the CRC), one set per length n.
const SHIFT_CAP = 4096;
const shiftTables = new Map();
function shiftTable(n) {
  let t = shiftTables.get(n);
  if (t) return t;
  const s = byteShift(n);
  t = new Int32Array(128);
  for (let k = 0; k < 8; k++)
    for (let v = 1; v < 16; v++) t[k * 16 + v] = gfMul(s, (v << (4 * k)) >>> 0);
  if (shiftTables.size >= SHIFT_CAP) shiftTables.clear();
  shiftTables.set(n, t);
  return t;
}
function crcOf(p) {
  if (p.shift == null) {
    p.crc = zlib.crc32(p.raw);
    p.shift = shiftTable(p.raw.length);
  }
  return p;
}
function crcJoin(crc, p) {
  const t = p.shift;
  return (
    (t[crc & 15] ^
      t[16 + ((crc >>> 4) & 15)] ^
      t[32 + ((crc >>> 8) & 15)] ^
      t[48 + ((crc >>> 12) & 15)] ^
      t[64 + ((crc >>> 16) & 15)] ^
      t[80 + ((crc >>> 20) & 15)] ^
      t[96 + ((crc >>> 24) & 15)] ^
      t[112 + (crc >>> 28)] ^
      p.crc) >>>
    0
  );
}
const zOf = (p) =>
  p.z || (p.z = zlib.deflateRawSync(p.raw, p.level === 1 ? SYNC1 : SYNC6));
function splitForms(html) {
  const parts = [];
  let last = 0,
    m;
  FORM_RE.lastIndex = 0;
  while ((m = FORM_RE.exec(html))) {
    const end = m.index + m[0].length;
    parts.push(piece(html.slice(last, end), 6));
    last = end;
  }
  FORM_RE.lastIndex = 0;
  parts.push(piece(html.slice(last), 6));
  return parts;
}
// Rows come from domain.js `presentation`; the key holds every row field the
// markup uses, so an entry is never reused for a different row.
function messageEntries(rows, origin, store) {
  const frozen = store && Object.isFrozen(rows);
  if (frozen) {
    const hit = entriesByRows.get(rows);
    if (hit && hit.origin === origin) return hit.out;
  }
  const out = new Array(rows.length),
    misses = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i],
      k = `${m.updated_at}|${m.created_at}|${m.client_message_id}|${m.creator_id}|${m.creator_name}|${m.creator_updated_at}|${m.room_id}|${m.room_name}|${m.body_updated_at}|${m.attachment_blob_id}`;
    const id = m.id + "|" + origin,
      hit = store && messageCache.get(id);
    if (hit && hit.k === k) {
      messageCache.delete(id);
      messageCache.set(id, hit);
      out[i] = hit;
    } else misses.push([i, id, k]);
  }
  if (misses.length) {
    const dots = messageData(
      misses.map(([i]) => rows[i]),
      origin,
    );
    misses.forEach(([i, id, k], j) => {
      const entry = { k, pieces: splitForms(renderMessageHTML(dots[j])) };
      out[i] = entry;
      if (store) {
        messageCache.delete(id);
        messageCache.set(id, entry);
        if (messageCache.size > MESSAGE_CAP)
          messageCache.delete(messageCache.keys().next().value);
      }
    });
  }
  if (frozen) entriesByRows.set(rows, { origin, out });
  return out;
}
// items: piece objects, 1 = escaped CSRF value, 2 = CSRF hidden input.
function buildPage(layout, entries, tokens) {
  const items = [];
  const add = (p) => p.raw.length && items.push(p);
  const addLayout = (text) =>
    text.split(TOKEN_MARK).forEach((t, i) => {
      if (i) items.push(1);
      if (t.length) items.push(layoutPiece(t));
    });
  let post = null;
  if (layout !== null) {
    const at = layout.indexOf(MESSAGES_MARK);
    addLayout(at < 0 ? layout : layout.slice(0, at));
    if (at >= 0) post = layout.slice(at + MESSAGES_MARK.length);
  }
  for (const entry of entries)
    entry.pieces.forEach((p, i) => {
      if (i && tokens) items.push(2);
      add(p);
    });
  if (post !== null) addLayout(post);
  let len = 0,
    n1 = 0,
    n2 = 0;
  for (const it of items)
    if (it === 1) n1++;
    else if (it === 2) n2++;
    else len += it.raw.length;
  return { id: ++pageSeq, items, len, n1, n2, key: entries };
}
let pageSeq = 0;
// SHA-1 ETags of token-less gzip bodies, per kept entries list. A hit needs
// the same ETag function and the very same deflate buffers in the same order,
// so the body bytes, and so the hash, are the same.
const etagMemo = new WeakMap();
function memoETag(req, res, page, list, count, size, body) {
  const fn = req.app?.get?.("etag fn");
  if (!fn) return;
  const hit = page.key && etagMemo.get(page.key);
  if (hit && hit.fn === fn && hit.size === size && hit.zs.length === count) {
    let same = true;
    for (let j = 0; j < count; j++)
      if (hit.zs[j] !== list[j + 1]) {
        same = false;
        break;
      }
    if (same) return res.set("ETag", hit.etag);
  }
  const etag = fn(body, "utf8");
  if (page.key)
    etagMemo.set(page.key, { fn, size, zs: list.slice(1, count + 1), etag });
  res.set("ETag", etag);
}
const BOOT = randomUUID();
const ETAG_BOOT = BOOT.slice(0, 8);
// Express would hash the whole body for its ETag. A page without a CSRF
// token gets that same ETag; a page with one gets one built from the page
// id and the token (the body differs on every request anyway).
function setETag(req, res, page, kind, body, tokenText, length) {
  const fn = req.app?.get?.("etag fn");
  if (!fn) return;
  if (body) return res.set("ETag", fn(body, "utf8"));
  // Process boot id, page id and a CRC-32 of the token: no hash object per request.
  res.set(
    "ETag",
    `W/"${length.toString(16)}-${ETAG_BOOT}${page.id.toString(36)}${kind}.${zlib.crc32(tokenText || "").toString(36)}"`,
  );
}
// The compression middleware's own Negotiator, so both pick the same encoding.
const localRequire = createRequire(import.meta.url);
const Negotiator = createRequire(localRequire.resolve("compression"))(
  "negotiator",
);
const brotli = typeof zlib.createBrotliCompress === "function";
const SUPPORTED = brotli
    ? ["br", "gzip", "deflate", "identity"]
    : ["gzip", "deflate", "identity"],
  PREFERRED = brotli ? ["br", "gzip"] : ["gzip"];
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;
// The answer depends only on the Accept-Encoding text, so it is kept per text.
const gzipByHeader = new Map();
function wantsGzip(req, res, length) {
  if (length < 1024 || req.method === "HEAD") return false;
  const ae = req.headers?.["accept-encoding"];
  if (!ae) return false;
  const cc = res.getHeader("Cache-Control");
  if (cc && NO_TRANSFORM.test(String(cc))) return false;
  let v = gzipByHeader.get(ae);
  if (v === undefined) {
    v = new Negotiator(req).encoding(SUPPORTED, PREFERRED) === "gzip";
    if (gzipByHeader.size > 100) gzipByHeader.clear();
    gzipByHeader.set(ae, v);
  }
  return v;
}
const GZ_HEAD = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
// Non-final stored deflate blocks; the stream before them is byte aligned.
function stored(buf) {
  const out = [];
  let o = 0;
  do {
    const c = buf.subarray(o, o + 65535),
      h = Buffer.alloc(5);
    h.writeUInt16LE(c.length, 1);
    h.writeUInt16LE(~c.length & 0xffff, 3);
    out.push(h, c);
    o += 65535;
  } while (o < buf.length);
  return Buffer.concat(out);
}
function emit(req, res, page) {
  res.type("html");
  const fixed = !page.n1 && !page.n2;
  let t1, t2, csrf;
  if (!fixed) {
    csrf = escape(req.csrfToken || "");
    t1 = Buffer.from(csrf);
    t2 = Buffer.from(
      `<input type="hidden" name="authenticity_token" value="${csrf}">`,
    );
  }
  const length =
    page.len + (fixed ? 0 : page.n1 * t1.length + page.n2 * t2.length);
  if (!wantsGzip(req, res, length)) {
    if (fixed) {
      const body = Buffer.concat(page.items.map((p) => p.raw));
      setETag(req, res, page, "raw", body);
      return res.send(body);
    }
    const list = new Array(page.items.length);
    for (let i = 0; i < list.length; i++) {
      const p = page.items[i];
      list[i] = p === 1 ? t1 : p === 2 ? t2 : p.raw;
    }
    setETag(req, res, page, "raw", null, csrf, length);
    return res.send(Buffer.concat(list, length));
  }
  res.set("Content-Encoding", "gzip");
  res.vary("Accept-Encoding");
  const s1 = t1 && stored(t1),
    s2 = t2 && stored(t2);
  const c1 = t1 && crcOf({ raw: t1, z: null, level: 0, crc: -1, shift: null }),
    c2 = t2 && crcOf({ raw: t2, z: null, level: 0, crc: -1, shift: null });
  const list = new Array(page.items.length + 2);
  list[0] = GZ_HEAD;
  let crc = 0,
    size = GZ_HEAD.length + 10,
    i = 1;
  for (const p of page.items) {
    let z;
    if (p === 1) {
      z = s1;
      crc = crcJoin(crc, c1);
    } else if (p === 2) {
      z = s2;
      crc = crcJoin(crc, c2);
    } else {
      z = zOf(p);
      crc = crcJoin(crc, crcOf(p));
    }
    list[i++] = z;
    size += z.length;
  }
  const tail = Buffer.alloc(10);
  tail[0] = 3; // final empty fixed-Huffman block, then CRC32 and ISIZE
  tail.writeUInt32LE(crc >>> 0, 2);
  tail.writeUInt32LE(length >>> 0, 6);
  list[i] = tail;
  const body = Buffer.concat(list, size);
  if (fixed) memoETag(req, res, page, list, i - 1, size, body);
  else setETag(req, res, page, "gz", null, csrf, size);
  return res.send(body);
}
// Full page with layout. `makeExtra()` returns the route data; its
// MessageRows/MessageOrigin are spliced in from the per-message cache.
export function sendPage(req, res, screen, ep, makeExtra) {
  const ok = usable(ep);
  const {
    MessageRows: rows,
    MessageOrigin: origin = "",
    ...extra
  } = makeExtra();
  const data = pageData(req, screen, extra);
  let entries = [];
  if (rows) {
    entries = messageEntries(rows, origin, ok);
    data.Messages = rows;
    data.MessagesHTML = safe(MESSAGES_MARK);
  }
  const layout = withCsrf(fragment(screen, data), TOKEN_MARK);
  if (rows && layout.split(MESSAGES_MARK).length !== 2)
    throw new Error(`${screen} page must print its messages exactly once`);
  return emit(req, res, buildPage(layout, entries, true));
}
// The bare messages list (pagination). Returns false when there are no rows.
export function sendMessages(req, res, ep, makeRows) {
  const ok = usable(ep);
  const rows = makeRows();
  if (!rows.length) return false;
  emit(req, res, buildPage(null, messageEntries(rows, "", ok), false));
  return true;
}
// A kept text part: its deflate is made once, on first use, and kept with it.
export const textPiece = (text) => piece(text, 1);
// Sends a page without CSRF tokens made of parts in order. A string part is
// new for this request and goes out as stored (not compressed) deflate
// blocks, so it costs no zlib work; a textPiece part reuses its kept deflate.
// The decoded body is the parts joined.
export function sendParts(req, res, parts) {
  const items = [];
  let len = 0;
  for (const p of parts) {
    let it = p;
    if (typeof p === "string") {
      const raw = Buffer.from(p);
      it = { raw, z: stored(raw), level: 0, crc: -1, shift: null };
    }
    if (!it.raw.length) continue;
    items.push(it);
    len += it.raw.length;
  }
  return emit(req, res, { id: ++pageSeq, items, len, n1: 0, n2: 0 });
}
