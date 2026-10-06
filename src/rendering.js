import nunjucks from "nunjucks";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
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

// ---- Response caches ------------------------------------------------------
// Everything below is dropped whenever db epoch() moves (any commit by any
// process). Routes call cacheEpoch() before they read the data a page shows
// and pass that value in; if the epoch moved before rendering, nothing is
// stored. A cached page is a list of pieces with the per-request CSRF token
// put back between them. Each piece keeps its own raw-deflate stream (ended
// with Z_SYNC_FLUSH), so a gzip response is the pieces joined with the token
// as stored blocks, one final empty block, and the CRC/length trailer.
const TOKEN_MARK = "\u0000" + randomUUID() + "\u0002";
const MESSAGES_MARK = "\u0000" + randomUUID() + "\u0001";
const MESSAGE_CAP = 5000,
  PAGE_CAP = 500;
const messageCache = new Map(),
  pageCache = new Map();
let currentEpoch = null;
export function cacheEpoch() {
  const e = dbEpoch();
  if (e !== currentEpoch) {
    messageCache.clear();
    pageCache.clear();
    currentEpoch = e;
  }
  return e;
}
const usable = (ep) => ep !== -1 && ep != null && cacheEpoch() === ep;
const SYNC6 = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
const SYNC1 = { level: 1, finishFlush: zlib.constants.Z_SYNC_FLUSH };
function piece(text, level) {
  return { raw: Buffer.from(text), z: null, level };
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
  return out;
}
// items: piece objects, 1 = escaped CSRF value, 2 = CSRF hidden input.
function buildPage(layout, entries, tokens) {
  const items = [];
  const add = (p) => p.raw.length && items.push(p);
  const addLayout = (text) =>
    text.split(TOKEN_MARK).forEach((t, i) => {
      if (i) items.push(1);
      add(piece(t, 1));
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
  return { id: ++pageSeq, items, len, n1, n2, raw: null, gz: null };
}
let pageSeq = 0;
const BOOT = randomUUID();
// Express would hash the whole body for its ETag on every request. A fixed
// page gets that same ETag once; a page with a CSRF token gets one built from
// the page identity and the token, which also changes exactly when the body does.
function setETag(req, res, page, kind, body, tokenText, length) {
  const fn = req.app?.get?.("etag fn");
  if (!fn) return;
  if (body) return res.set("ETag", (page["etag" + kind] ||= fn(body, "utf8")));
  const hash = createHash("sha1")
    .update(`${BOOT}|${page.id}|${kind}|${tokenText}`)
    .digest("base64")
    .slice(0, 27);
  res.set("ETag", `W/"${length.toString(16)}-${hash}"`);
}
function storePage(key, page) {
  pageCache.set(key, page);
  if (pageCache.size > PAGE_CAP)
    pageCache.delete(pageCache.keys().next().value);
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
// Gzip of a page with CSRF tokens, built once per token length. Each token
// is written as a fixed byte pattern P that can never occur in UTF-8 text
// (bytes C0, C1, F5-FF; every pair of neighbouring bytes is different). A
// token more than WINDOW_GAP bytes after the one before it is an "anchor":
// it gets its own stored block, which each request overwrites with the real
// token. The text between anchors is one deflate stream whose dictionary is
// the text before it, so later tokens are copied from earlier ones by
// back-references and decode to the real token too. The result is decoded
// with two test tokens before use; on any mismatch the caller falls back to
// splicing pieces (null).
const INPUT_HEAD = Buffer.from(
    '<input type="hidden" name="authenticity_token" value="',
  ),
  INPUT_TAIL = Buffer.from('">');
const WINDOW_GAP = 30000;
function placeholder(L) {
  const sym = [
    0xc0, 0xc1, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe,
    0xff,
  ];
  const k = sym.length,
    seq = [],
    a = new Array(k * 2).fill(0);
  // de Bruijn sequence B(13, 2): every pair of symbols occurs once.
  (function db(t, p) {
    if (t > 2) {
      if (2 % p === 0) for (let j = 1; j <= p; j++) seq.push(a[j]);
    } else {
      a[t] = a[t - p];
      db(t + 1, p);
      for (let j = a[t - p] + 1; j < k; j++) {
        a[t] = j;
        db(t + 1, t);
      }
    }
  })(1, 1);
  if (L > seq.length) return null;
  return Buffer.from(seq.slice(0, L).map((i) => sym[i]));
}
// CRC-32 arithmetic from zlib's crc32_combine. Two bodies of equal length
// that differ only where tokens are have CRCs that differ by a linear term,
// so a request needs one 88-byte CRC and one multiply instead of a CRC of
// the whole page.
function multmodp(a, b) {
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
const X2N = [0x40000000];
for (let i = 1; i < 32; i++) X2N.push(multmodp(X2N[i - 1], X2N[i - 1]));
function x2nmodp(n, k) {
  let p = 0x80000000;
  while (n) {
    if (n & 1) p = multmodp(X2N[k & 31], p);
    n = Math.floor(n / 2);
    k++;
  }
  return p >>> 0;
}
// x^(8*bytes) mod P: moves a CRC term `bytes` bytes further from the end.
const shiftBytes = (bytes) => x2nmodp(bytes, 3);
let crcScratch = Buffer.alloc(128);
function tokenCrc(g, token) {
  if (crcScratch.length < token.length) crcScratch = Buffer.alloc(token.length);
  const d = crcScratch.subarray(0, token.length);
  for (let i = 0; i < d.length; i++) d[i] = token[i] ^ g.P[i];
  return (g.crc ^ multmodp(g.S, (zlib.crc32(d) ^ g.zeroCrc) >>> 0)) >>> 0;
}
function templateGzip(page, L) {
  const P = placeholder(L);
  if (!P) return null;
  const parts = [],
    tokens = [];
  let pos = 0;
  const put = (b) => (parts.push(b), (pos += b.length));
  for (const it of page.items)
    if (it === 1) (tokens.push(pos), put(P));
    else if (it === 2)
      (put(INPUT_HEAD), tokens.push(pos), put(P), put(INPUT_TAIL));
    else put(it.raw);
  const tpl = Buffer.concat(parts, pos);
  const out = [GZ_HEAD],
    anchors = [];
  let size = GZ_HEAD.length,
    start = 0,
    prevEnd = -Infinity;
  const deflate = (end, finish) => {
    const options = {
      finishFlush: finish
        ? zlib.constants.Z_FINISH
        : zlib.constants.Z_SYNC_FLUSH,
    };
    if (start > 0)
      options.dictionary = tpl.subarray(Math.max(0, start - 32768), start);
    const z = zlib.deflateRawSync(tpl.subarray(start, end), options);
    out.push(z);
    size += z.length;
  };
  for (const at of tokens) {
    if (at - prevEnd > WINDOW_GAP) {
      deflate(at, false);
      const block = stored(P);
      anchors.push(size + 5);
      out.push(block);
      size += block.length;
      start = at + L;
    }
    prevEnd = at + L;
  }
  deflate(pos, true);
  const z = Buffer.concat(out, size);
  // S = sum of x^(8*(bytes after each token)), by Horner over the gaps
  // between tokens (gaps repeat a lot, so they are memoized).
  let S = 0,
    prev = -1;
  const gaps = new Map();
  const shiftGap = (n) => {
    let v = gaps.get(n);
    if (v === undefined) gaps.set(n, (v = shiftBytes(n)));
    return v;
  };
  for (const at of tokens) {
    S =
      prev < 0
        ? 0x80000000
        : (multmodp(shiftGap(at - prev), S) ^ 0x80000000) >>> 0;
    prev = at;
  }
  if (prev >= 0) S = multmodp(shiftGap(pos - prev - L), S);
  const g = {
    L,
    z,
    anchors,
    P,
    S: S >>> 0,
    crc: zlib.crc32(tpl),
    zeroCrc: zlib.crc32(Buffer.alloc(L)),
  };
  // Check: decode with test tokens and compare with the expected text.
  for (const seed of [0, 1]) {
    const T = Buffer.alloc(L);
    for (let i = 0; i < L; i++)
      T[i] = 33 + ((seed ? (i * 37 + 11) % 89 : (i * 53 + 7) % 89) % 94);
    const test = Buffer.from(z);
    for (const at of anchors) T.copy(test, at);
    const expected = Buffer.from(tpl);
    for (const at of tokens) T.copy(expected, at);
    let decoded;
    try {
      decoded = zlib.inflateRawSync(test.subarray(GZ_HEAD.length));
    } catch {
      return null;
    }
    if (!decoded.equals(expected)) return null;
    if (tokenCrc(g, T) !== zlib.crc32(expected)) return null;
  }
  return g;
}
// What res.send does for a 200 Buffer body, without its helpers: used only
// when the request has no conditional headers (so no 304) and is a GET.
const HTML_TYPE = "text/html; charset=utf-8";
function quick(req) {
  const h = req.headers;
  return (
    req.method === "GET" &&
    h["if-none-match"] === undefined &&
    h["if-modified-since"] === undefined &&
    typeof req.app?.get === "function"
  );
}
function finish(res, body, etag, gz) {
  res.setHeader("Content-Type", HTML_TYPE);
  if (gz) {
    res.setHeader("Content-Encoding", "gzip");
    const vary = res.getHeader("Vary");
    if (vary === undefined) res.setHeader("Vary", "Accept-Encoding");
    else res.vary("Accept-Encoding");
  }
  res.setHeader("ETag", etag);
  res.setHeader("Content-Length", body.length);
  res.end(body);
}
// Weak ETag the same way Express' default "etag fn" makes it.
const weakEtag = createRequire(localRequire.resolve("express"))("etag");
const gzipFor = (ae) => {
  if (!ae) return false;
  let v = gzipByHeader.get(ae);
  if (v === undefined) {
    v =
      new Negotiator({ headers: { "accept-encoding": ae } }).encoding(
        SUPPORTED,
        PREFERRED,
      ) === "gzip";
    if (gzipByHeader.size > 100) gzipByHeader.clear();
    gzipByHeader.set(ae, v);
  }
  return v;
};
// The 200 body for a cached page and this request's CSRF token, or null when
// only the slow path in emit() can build it (plain token page, no template).
function respond(page, csrfToken, gzipOk) {
  if (!page.n1 && !page.n2) {
    const body = (page.raw ||= Buffer.concat(page.items.map((p) => p.raw)));
    if (body.length < 1024 || !gzipOk)
      return {
        body,
        etag: (page.etagraw ||= weakEtag(body, { weak: true })),
        gz: false,
      };
    page.gz ||= zlib.gzipSync(body);
    return {
      body: page.gz,
      etag: (page.etaggz ||= weakEtag(page.gz, { weak: true })),
      gz: true,
    };
  }
  const t1 = Buffer.from(escape(csrfToken || ""));
  const length =
    page.len +
    page.n1 * t1.length +
    page.n2 * (t1.length + INPUT_HEAD.length + INPUT_TAIL.length);
  if (length < 1024 || !gzipOk) return null;
  if (page.tpl?.L !== t1.length)
    page.tpl = templateGzip(page, t1.length) || { L: t1.length, z: null };
  const g = page.tpl;
  if (!g.z) return null;
  const crc = tokenCrc(g, t1);
  const n = g.z.length,
    body = slabBuffer(n + 8);
  g.z.copy(body);
  for (const at of g.anchors) t1.copy(body, at);
  body.writeUInt32LE(crc >>> 0, n);
  body.writeUInt32LE(length >>> 0, n + 4);
  // The body CRC (with page id, length and a CRC of the token) names this body.
  const etag = `W/"${body.length.toString(16)}-${BOOT_TAG}${page.id.toString(36)}.${crc.toString(36)}.${zlib.crc32(t1).toString(36)}"`;
  return { body, etag, gz: true };
}
// Cached-page bodies are cut from a 1 MB slab and never reused: a body still
// being written keeps its old slab alive, and a full slab is replaced. This
// skips one ArrayBuffer allocation per hit.
const SLAB = 1 << 20;
let slab = null,
  slabAt = 0;
function slabBuffer(size) {
  if (size > SLAB >>> 3) return Buffer.allocUnsafe(size);
  if (slab === null || slabAt + size > SLAB) {
    slab = Buffer.allocUnsafeSlow(SLAB);
    slabAt = 0;
  }
  const b = slab.subarray(slabAt, slabAt + size);
  slabAt = (slabAt + size + 7) & ~7;
  return b;
}
function emitQuick(req, res, page) {
  const e = req.app.get("etag");
  if (e !== "weak" && e !== true) return null;
  const cc = res.getHeader("Cache-Control");
  const gzipOk =
    !(cc && NO_TRANSFORM.test(String(cc))) &&
    gzipFor(req.headers["accept-encoding"]);
  const r = respond(page, req.csrfToken, gzipOk);
  if (!r) return null;
  const rec = req.fastRecord;
  if (rec) {
    rec.page = page;
    rec.gzipOk = gzipOk;
  }
  return finish(res, r.body, r.etag, r.gz);
}
// Raw fast path (src/app.js): true while `page` is still the cache entry for
// `key` at epoch `ep`, i.e. what sendPage/sendMessages would serve.
export function pageCurrent(key, page, ep) {
  return currentEpoch === ep && pageCache.get(key) === page;
}
// Body and ETag exactly as emitQuick() sends them, for a fresh CSRF mask.
export function fastPageBody(page, rawCsrf, gzipOk) {
  return respond(
    page,
    !page.n1 && !page.n2 ? undefined : rails.maskCsrf(rawCsrf),
    gzipOk,
  );
}
// For a front server that skips Express: the cached page for this request, as
// writeHead() header pairs plus body, or null on a miss (then run the route).
// ctx: { screen, key, ep, protocol, host, turboFrame, lastRoomId, user,
//        csrfToken, acceptEncoding }. screen "messages" is the bare list
// (sendMessages); key and ep are what the route passes to sendPage().
// The caller adds the security headers and Set-Cookie, and must only use
// this for a GET without If-None-Match / If-Modified-Since.
export function pageHit(ctx) {
  const page = lookup(
    ctx.screen,
    ctx.key,
    ctx.ep,
    ctx.protocol,
    ctx.host,
    ctx.turboFrame,
    ctx.lastRoomId,
    ctx.user,
  );
  if (!page) return null;
  const r = respond(page, ctx.csrfToken, gzipFor(ctx.acceptEncoding));
  if (!r) return null;
  const headers = ["Content-Type", HTML_TYPE];
  if (r.gz) headers.push("Content-Encoding", "gzip", "Vary", "Accept-Encoding");
  headers.push("ETag", r.etag, "Content-Length", String(r.body.length));
  return { status: 200, headers, body: r.body };
}
const BOOT_TAG = BOOT.slice(0, 8);
function emit(req, res, page) {
  if (quick(req) && emitQuick(req, res, page) !== null) return;
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
      const body = (page.raw ||= Buffer.concat(page.items.map((p) => p.raw)));
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
  if (fixed) {
    // No CSRF token: one ordinary gzip of the whole body, made once.
    page.gz ||= zlib.gzipSync(
      (page.raw ||= Buffer.concat(page.items.map((p) => p.raw))),
    );
    setETag(req, res, page, "gz", page.gz);
    return res.send(page.gz);
  }
  if (page.tpl?.L !== t1.length)
    page.tpl = templateGzip(page, t1.length) || { L: t1.length, z: null };
  const g = page.tpl;
  if (g.z) {
    const crc = tokenCrc(g, t1);
    const n = g.z.length,
      body = Buffer.allocUnsafe(n + 8);
    g.z.copy(body);
    for (const at of g.anchors) t1.copy(body, at);
    body.writeUInt32LE(crc >>> 0, n);
    body.writeUInt32LE(length >>> 0, n + 4);
    setETag(req, res, page, "gzt", null, csrf, body.length);
    return res.send(body);
  }
  const s1 = t1 && stored(t1),
    s2 = t2 && stored(t2);
  const list = [GZ_HEAD];
  let crc = 0,
    size = GZ_HEAD.length + 10;
  for (const p of page.items) {
    let z;
    if (p === 1) {
      z = s1;
      crc = zlib.crc32(t1, crc);
    } else if (p === 2) {
      z = s2;
      crc = zlib.crc32(t2, crc);
    } else {
      z = zOf(p);
      crc = zlib.crc32(p.raw, crc);
    }
    list.push(z);
    size += z.length;
  }
  const tail = Buffer.alloc(10);
  tail[0] = 3; // final empty fixed-Huffman block, then CRC32 and ISIZE
  tail.writeUInt32LE(crc >>> 0, 2);
  tail.writeUInt32LE(length >>> 0, 6);
  list.push(tail);
  const body = Buffer.concat(list, size);
  setETag(req, res, page, "gz", null, csrf, size);
  return res.send(body);
}
// Full page with layout. `makeExtra()` runs only on a cache miss; its
// MessageRows/MessageOrigin are spliced in from the per-message cache. `key`
// names what the route data depends on besides the user row, host, protocol,
// Turbo-Frame and session last room; null turns the page cache off.
// The route called cacheEpoch() just before, so a lookup only needs the epoch
// to still be the current one; stores check it again with usable().
const current = (ep) => ep !== -1 && ep != null && ep === currentEpoch;
// The key holds the user id; the whole row is compared field by field on a hit
// (cheaper than putting JSON.stringify(row) in the key on every request).
function sameRow(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  let n = 0;
  for (const k in a) {
    if (a[k] !== b[k]) return false;
    n++;
  }
  for (const k in b) n--;
  return n === 0;
}
const pageKey = (screen, key, protocol, host, turboFrame, lastRoomId, user) =>
  screen === "messages"
    ? "messages|" + key
    : `${screen}|${key}|${protocol}|${host}|${!!turboFrame}|${lastRoomId || ""}|${user ? user.id : ""}`;
function lookup(screen, key, ep, protocol, host, turboFrame, lastRoomId, user) {
  if (!current(ep) || key == null) return null;
  const page = pageCache.get(
    pageKey(screen, key, protocol, host, turboFrame, lastRoomId, user),
  );
  return page && (screen === "messages" || sameRow(page.user, user || null))
    ? page
    : null;
}
export function sendPage(req, res, screen, ep, key, makeExtra) {
  const h = req.headers || {};
  const fullKey =
    current(ep) && key != null
      ? pageKey(
          screen,
          key,
          req.protocol,
          h.host,
          h["turbo-frame"],
          req.session?.last_room_id,
          req.user,
        )
      : null;
  let page = fullKey && pageCache.get(fullKey);
  if (page && !sameRow(page.user, req.user || null)) page = null;
  if (!page) {
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
    page = buildPage(layout, entries, true);
    page.user = req.user || null;
    if (fullKey && usable(ep)) storePage(fullKey, page);
  }
  if (req.fastRecord) req.fastRecord.key = fullKey;
  return emit(req, res, page);
}
// The bare messages list (pagination). Returns false when there are no rows.
export function sendMessages(req, res, ep, key, makeRows) {
  const fullKey = current(ep) && key != null ? "messages|" + key : null;
  let page = fullKey && pageCache.get(fullKey);
  if (!page) {
    const ok = usable(ep);
    const rows = makeRows();
    if (!rows.length) return false;
    page = buildPage(null, messageEntries(rows, "", ok), false);
    if (fullKey && usable(ep)) storePage(fullKey, page);
  }
  if (req.fastRecord) req.fastRecord.key = fullKey;
  emit(req, res, page);
  return true;
}
