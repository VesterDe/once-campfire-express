import express from "express";
import compression from "compression";
import multer from "multer";
import path from "node:path";
import { randomBytes, hash as cryptoHash } from "node:crypto";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import * as rails from "./rails.js";
import { get, all, run, now, initialize, epoch } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerStorage } from "./storage.js";
import { registerPublic } from "./public.js";
import { registerOpengraph } from "./opengraph.js";
import { allowLogin } from "./rate_limit.js";
import { pageCurrent, fastPageBody } from "./rendering.js";

export function parseCookies(header = "") {
  const result = Object.create(null);
  for (const item of header.split(";")) {
    const i = item.indexOf("=");
    if (i < 0) continue;
    const k = item.slice(0, i).trim();
    try {
      result[k] = decodeURIComponent(item.slice(i + 1).trim());
    } catch {}
  }
  return result;
}
export function authenticateCookies(header) {
  try {
    const token = rails.verifyCookieCached(
      "session_token",
      parseCookies(header).session_token,
    );
    return get(
      "SELECT s.*,u.name,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status=0",
      token,
    );
  } catch {
    return null;
  }
}
// One query for the session and its user; "__s_" columns belong to the session.
const SESSION_USER_SQL =
  "SELECT s.id AS __s_id,s.created_at AS __s_created_at,s.ip_address AS __s_ip_address,s.last_active_at AS __s_last_active_at,s.token AS __s_token,s.updated_at AS __s_updated_at,s.user_agent AS __s_user_agent,s.user_id AS __s_user_id,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.status=0";
function sessionAndUser(cookies) {
  let token;
  try {
    token = rails.verifyCookieCached("session_token", cookies.session_token);
  } catch {
    return [null, null];
  }
  if (typeof token !== "string") return lookupSession(token);
  let hit = sessionUsers.get(token);
  if (hit === undefined) {
    hit = lookupSession(token);
    if (sessionUsers.size >= 10000) sessionUsers.clear();
    sessionUsers.set(token, hit);
  }
  return hit[0] ? [{ ...hit[0] }, { ...hit[1] }] : [null, null];
}
function lookupSession(token) {
  let row;
  try {
    row = get(SESSION_USER_SQL, token);
  } catch {
    return [null, null];
  }
  if (!row) return [null, null];
  const session = {},
    user = {};
  for (const k in row)
    if (k.startsWith("__s_")) session[k.slice(4)] = row[k];
    else user[k] = row[k];
  session.name = user.name;
  session.role = user.role;
  session.status = user.status;
  return [session, user];
}
// The same incoming cookie that turns into the same new session (for example
// the room page setting last_room_id on every visit) reuses the value encrypted
// less than a second ago. Only the embedded expiry can lag by under a second.
const sessionCookies = new Map();
function sessionCookie(incoming, json, session, expiry) {
  const key = (incoming || "") + "\0" + json;
  const hit = sessionCookies.get(key);
  if (
    hit &&
    hit.secret === process.env.SECRET_KEY_BASE &&
    hit.expiry <= expiry &&
    expiry - hit.expiry < 1000
  )
    return hit.value;
  const value = rails.encryptCookie("_campfire_session", session, expiry);
  if (sessionCookies.size >= 10000) sessionCookies.clear();
  sessionCookies.set(key, {
    value,
    expiry,
    secret: process.env.SECRET_KEY_BASE,
  });
  return value;
}
// Process-local copies of rarely changing rows, dropped when epoch() moves.
let cachedEpoch = null,
  cachedAccount,
  cachedBans;
const sessionUsers = new Map();
function refreshCaches(e) {
  if (e !== cachedEpoch || e < 0) {
    sessionUsers.clear();
    cachedAccount = get("SELECT * FROM accounts ORDER BY id LIMIT 1");
    cachedBans = new Set(
      all("SELECT ip_address FROM bans").map((r) => r.ip_address),
    );
    cachedEpoch = e;
  }
}
function sessionMiddleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.session = {};
  try {
    const session = rails.decryptCookieCached(
      "_campfire_session",
      req.cookies._campfire_session,
    );
    if (session && typeof session === "object" && !Array.isArray(session))
      req.session = session;
  } catch {}
  const before = rails.stringify(req.session);
  try {
    if (rails.decode64(req.session._csrf_token).length !== 32)
      delete req.session._csrf_token;
  } catch {
    delete req.session._csrf_token;
  }
  const freshSession = !req.session.session_id || !req.session._csrf_token;
  req.session.session_id ||= randomBytes(16).toString("hex");
  req.session._csrf_token ||= rails.b64(randomBytes(32));
  req.csrfToken = rails.maskCsrf(rails.decode64(req.session._csrf_token));
  refreshCaches((req.epoch = epoch()));
  [req.currentSession, req.user] = sessionAndUser(req.cookies);
  req.authenticatedByBot = false;
  if (!req.user) {
    const botMatch = req.path.match(/^\/rooms\/\d+\/([^/]+)\/messages(?:\/|$)/);
    const botKey = req.query.bot_key || botMatch?.[1];
    if (botKey) {
      const m = String(botKey)
        .trim()
        .match(/^(\d+)-(.+)$/);
      if (m) {
        req.user = get(
          "SELECT * FROM users WHERE id=? AND bot_token=? AND status=0 AND role=2",
          Number(m[1]),
          m[2],
        );
        req.authenticatedByBot = Boolean(req.user);
      }
    }
  }
  if (
    req.currentSession &&
    new Date(
      req.currentSession.last_active_at.replace(" ", "T") + "Z",
    ).getTime() <
      Date.now() - 3600000
  ) {
    run(
      "UPDATE sessions SET last_active_at=?,updated_at=?,user_agent=?,ip_address=? WHERE id=?",
      now(),
      now(),
      req.headers["user-agent"] || "",
      req.ip,
      req.currentSession.id,
    );
    refreshCaches((req.epoch = epoch()));
  }
  req.account = cachedAccount && { ...cachedAccount };
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const options = {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      maxAge: 20 * 365 * 86400 * 1000,
      path: "/",
    };
    const expiry = new Date(Date.now() + options.maxAge);
    const after = rails.stringify(req.session);
    if (after !== before)
      res.cookie(
        "_campfire_session",
        sessionCookie(
          req.cookies._campfire_session,
          after,
          req.session,
          expiry,
        ),
        options,
      );
    if (req.clearSessionToken)
      res.clearCookie("session_token", { ...options, maxAge: undefined });
    else if (req.newSessionToken)
      res.cookie(
        "session_token",
        rails.signCookie("session_token", req.newSessionToken, expiry),
        options,
      );
    if (req.lastRoom !== undefined)
      res.cookie("last_room", String(req.lastRoom), {
        ...options,
        httpOnly: false,
      });
    if (req.fastRecord?.page && !freshSession)
      recordFast(req, this, args, after !== before ? after : null, expiry);
    return writeHead.apply(this, args);
  };
  next();
}
function multipartFields(req, res, next) {
  if (req.is("multipart/form-data")) {
    for (const [name, value] of Object.entries(req.body || {})) {
      const parts = name.match(/[^\[\]]+/g) || [];
      if (
        parts.length < 2 ||
        parts.some((p) => ["__proto__", "constructor", "prototype"].includes(p))
      )
        continue;
      let target = req.body;
      for (const p of parts.slice(0, -1))
        target = target[p] ||= Object.create(null);
      target[parts.at(-1)] = value;
    }
  }
  next();
}
// Whole-body responses are gzipped synchronously at level 1 (faster than the
// compression() stream + threadpool hop). Streams, br/deflate clients and
// bodies that already carry Content-Encoding fall through to compression().
const compressionRequire = createRequire(
  createRequire(import.meta.url).resolve("compression"),
);
const Negotiator = compressionRequire("negotiator"),
  vary = compressionRequire("vary");
const negotiated = new Map();
function contentCoding(header) {
  if (!header) return "identity";
  let method = negotiated.get(header);
  if (method === undefined) {
    method =
      new Negotiator({ headers: { "accept-encoding": header } }).encoding(
        ["br", "gzip", "deflate", "identity"],
        ["br", "gzip"],
      ) || "";
    if (negotiated.size >= 1000) negotiated.clear();
    negotiated.set(header, method);
  }
  return method;
}
const HOT_PATH =
  /^\/(?:rooms\/\d+(?:\/messages)?|users\/me\/sidebar|searches)$/;
const POST_PATH = /^\/rooms\/\d+\/messages$/;
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/;
function encodingMiddleware() {
  const compress = compression();
  return (req, res, next) => {
    const method = contentCoding(req.headers["accept-encoding"]);
    // Posting a message: answer without gzip (identity is always acceptable;
    // the ~8 KB turbo stream costs more CPU to gzip than it saves).
    if (method === "gzip" && req.method === "POST" && POST_PATH.test(req.path))
      return wrap(req, res, "identity", next);
    if (
      method === "br" ||
      method === "deflate" ||
      req.method !== "GET" ||
      !HOT_PATH.test(req.path)
    )
      compress(req, res, () => wrap(req, res, method, next));
    else wrap(req, res, method, next);
  };
}
// Runs after compression() so this end() is the outer one the handler calls.
function wrap(req, res, method, next) {
  {
    const end = res.end;
    res.end = function (chunk, encoding, callback) {
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }
      if (chunk == null || this.headersSent)
        return end.call(this, chunk, encoding, callback);
      if (typeof chunk === "string")
        chunk = Buffer.from(chunk, encoding || "utf8");
      if (
        compression.filter(req, res) &&
        !NO_TRANSFORM.test(this.getHeader("Cache-Control") || "")
      ) {
        vary(this, "Accept-Encoding");
        if (
          method === "gzip" &&
          req.method !== "HEAD" &&
          this.statusCode !== 204 &&
          this.statusCode !== 304 &&
          !this.getHeader("Content-Encoding") &&
          Number(this.getHeader("Content-Length") ?? chunk.length) >= 1024
        ) {
          chunk = zlib.gzipSync(chunk, { level: 1 });
          this.setHeader("Content-Encoding", "gzip");
          this.setHeader("Content-Length", chunk.length);
        }
      }
      return end.call(this, chunk, callback);
    };
    next();
  }
}
// Lean router for the hot GET pages. It is the app's own router stack minus
// the layers marked skip(), which are no-ops for a GET without a body whose
// path matches HOT_PATH and carries no .json/.turbo_stream suffix (asset
// static, format suffix rewrite, body parsers, multipart, method override).
// Session, bans, CSRF, routes, 404 and error handling run unchanged.
const Router = createRequire(createRequire(import.meta.url).resolve("express"))(
  "router",
);
const skip = (fn) => ((fn.skipOnFastPath = true), fn);
const FORMAT_SUFFIX = /\.(json|turbo_stream)(?=\?|$)/;
const fastApps = new WeakMap();
export function fastPath(app, req, res) {
  if (req.method !== "GET") return false;
  const h = req.headers;
  if (h["content-length"] !== undefined || h["transfer-encoding"] !== undefined)
    return false;
  const url = req.url;
  const e = rawFastStats.enabled ? findFast(req) : undefined;
  if (e !== undefined && rawFast(e, req, res)) return true;
  const q = url.indexOf("?");
  if (!HOT_PATH.test(q < 0 ? url : url.slice(0, q)) || FORMAT_SUFFIX.test(url))
    return false;
  let lean = fastApps.get(app);
  if (!lean) {
    const router = new Router({
      caseSensitive: app.enabled("case sensitive routing"),
      strict: app.enabled("strict routing"),
    });
    router.params = app.router.params;
    router.stack = app.router.stack.filter((l) => !l.handle.skipOnFastPath);
    lean = Object.create(app, { router: { value: router } });
    fastApps.set(app, lean);
  }
  req.body = undefined;
  req.fastRecord =
    h["if-none-match"] === undefined &&
    h["if-modified-since"] === undefined &&
    rails.realClock &&
    (h["accept-encoding"] === undefined ||
      contentCoding(h["accept-encoding"]) === "gzip" ||
      contentCoding(h["accept-encoding"]) === "identity")
      ? {}
      : null;
  lean.handle(req, res);
  return true;
}
// ---- Raw fast path --------------------------------------------------------
// A repeat of a hot GET with byte-identical URL, headers and client address
// is answered without Express: the first answer (through the normal path)
// records everything derived from the request; a repeat is served from the
// same page cache entry with a fresh CSRF mask, ETag and cookie expiry while
// the db epoch, the page entry, the session cookie memo (1 s), the session
// activity window and the cookie expiries all still hold. Anything else goes
// through the normal path.
const fastEntries = new Map();
export const rawFastStats = { enabled: true, hits: 0 };
const MAX_AGE = 20 * 365 * 86400 * 1000;
// Entries per URL; a request matches an entry when its client address and
// raw header list (names, values, order) are identical.
function findFast(req) {
  const list = fastEntries.get(req.url);
  if (list === undefined) return undefined;
  const raw = req.rawHeaders,
    n = raw.length,
    addr = req.socket.remoteAddress;
  next: for (let j = 0; j < list.length; j++) {
    const e = list[j],
      r = e.raw;
    if (r.length !== n || e.addr !== addr) continue;
    for (let i = n - 1; i >= 0; i--) if (r[i] !== raw[i]) continue next;
    return e;
  }
  return undefined;
}
function dropFast(e) {
  const list = fastEntries.get(e.url);
  if (list === undefined) return;
  const i = list.indexOf(e);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) fastEntries.delete(e.url);
}
let expSecond = -1,
  expText = "";
function expiresText(nowMs) {
  const sec = Math.floor(nowMs / 1000);
  if (sec !== expSecond) {
    expText = new Date(nowMs + MAX_AGE).toUTCString();
    expSecond = sec;
  }
  return expText;
}
function recordFast(req, res, args, sessionJson, expiry) {
  const rec = req.fastRecord;
  req.fastRecord = null;
  const status = typeof args[0] === "number" ? args[0] : res.statusCode;
  if (
    status !== 200 ||
    args.length > 1 ||
    !rec.key ||
    !req.user ||
    !req.currentSession ||
    req.authenticatedByBot ||
    req.clearSessionToken ||
    req.newSessionToken ||
    req.method !== "GET" ||
    req.epoch == null ||
    req.epoch < 0 ||
    !pageCurrent(rec.key, rec.page, req.epoch)
  )
    return;
  let csrf;
  try {
    csrf = rails.decode64(req.session._csrf_token);
  } catch {
    return;
  }
  if (csrf.length !== 32) return;
  const raw = req.cookies;
  let validUntil =
    new Date(
      req.currentSession.last_active_at.replace(" ", "T") + "Z",
    ).getTime() +
    3600000 +
    1;
  for (const [kind, name] of [
    ["s", "session_token"],
    ["e", "_campfire_session"],
  ]) {
    if (raw[name] === undefined) continue;
    if (typeof raw[name] !== "string") return;
    const exp = rails.cachedCookieExpiry(kind, name, raw[name]);
    if (exp === undefined) return;
    if (exp !== null) validUntil = Math.min(validUntil, exp);
  }
  if (!(validUntil > Date.now())) return;
  const expires = "Expires=" + expiry.toUTCString();
  const template = [],
    slots = {};
  let sessValue = null;
  for (const name of res.getRawHeaderNames()) {
    const lower = name.toLowerCase();
    const value = res.getHeader(name);
    if (lower === "date") return;
    if (lower === "etag") {
      slots.etag = template.length + 1;
      template.push(name, "");
    } else if (lower === "content-length") {
      slots.len = template.length + 1;
      template.push(name, "");
    } else if (lower === "set-cookie") {
      for (const c of Array.isArray(value) ? value : [value]) {
        const at = c.indexOf(expires);
        if (at < 0) return;
        if (c.startsWith("_campfire_session=")) {
          if (sessionJson === null) return;
          sessValue = c.slice(18, c.indexOf(";"));
        }
        (slots.cookies ||= []).push([
          template.length + 1,
          c.slice(0, at + 8),
          c.slice(at + expires.length),
        ]);
        template.push(name, "");
      }
    } else if (Array.isArray(value)) {
      for (const v of value) template.push(name, String(v));
    } else template.push(name, String(value));
  }
  if (slots.len === undefined) return;
  let sessKey = null;
  if (sessionJson !== null) {
    if (sessValue === null) return;
    sessKey = (raw._campfire_session || "") + "\0" + sessionJson;
    const memo = sessionCookies.get(sessKey);
    if (!memo || encodeURIComponent(memo.value) !== sessValue) return;
    sessValue = memo.value;
  }
  const old = findFast(req);
  if (old !== undefined) dropFast(old);
  if (fastEntries.size >= 1000) fastEntries.clear();
  let list = fastEntries.get(req.url);
  if (list === undefined) fastEntries.set(req.url, (list = []));
  if (list.length >= 64) list.shift();
  list.push({
    url: req.url,
    addr: req.socket.remoteAddress,
    raw: req.rawHeaders.slice(),
    epoch: req.epoch,
    key: rec.key,
    page: rec.page,
    gzipOk: rec.gzipOk,
    csrf,
    status,
    template,
    slots,
    sessKey,
    sessValue,
    validUntil,
    secret: process.env.SECRET_KEY_BASE,
  });
}
function rawFast(e, req, res) {
  const c = rawBuilt(e, Date.now(), -2);
  if (c === null) return false;
  rawFastStats.hits++;
  res.writeHead(e.status, c.h);
  res.end(c.body);
  return true;
}
// Validity checks plus the per-second build. ep is a db epoch already read in
// this same synchronous run (net front, pipelined batch) or -2 to read it now.
function rawBuilt(e, t, ep) {
  if (
    !(t < e.validUntil) ||
    !rails.realClock ||
    e.secret !== process.env.SECRET_KEY_BASE ||
    (ep === -2 ? epoch() : ep) !== e.epoch ||
    e.epoch !== cachedEpoch ||
    !pageCurrent(e.key, e.page, e.epoch)
  ) {
    dropFast(e);
    return null;
  }
  if (e.sessKey !== null) {
    const memo = sessionCookies.get(e.sessKey),
      expiry = t + MAX_AGE;
    if (
      !memo ||
      memo.value !== e.sessValue ||
      memo.secret !== e.secret ||
      !(memo.expiry <= expiry && expiry - memo.expiry < 1000)
    )
      return null;
  }
  // Body and headers are built once per entry per clock second: the CSRF
  // mask, ETag and cookie Expires stay the same within that second.
  const sec = Math.floor(t / 1000);
  let c = e.built;
  if (c === undefined || c.sec !== sec) {
    const r = fastPageBody(e.page, e.csrf, e.gzipOk);
    if (r === null) return null;
    const h = e.template.slice(),
      s = e.slots;
    h[s.len] = String(r.body.length);
    if (s.etag !== undefined) h[s.etag] = r.etag;
    if (s.cookies !== undefined) {
      const x = expiresText(t);
      for (const [i, a, b] of s.cookies) h[i] = a + x + b;
    }
    c = e.built = { sec, h, body: r.body, net: null, tail: "" };
  }
  return c;
}
// Net front entry (src/netfront.js): the whole HTTP/1.1 response as one
// Buffer, byte-identical to what node:http writes for rawFast (headers, then
// Date, Connection: keep-alive and Keep-Alive), or null to use node:http.
const fakeReq = { url: "", rawHeaders: null, socket: { remoteAddress: "" } };
export function netFast(url, rawHeaders, addr, tail, ep) {
  if (!rawFastStats.enabled) return null;
  fakeReq.url = url;
  fakeReq.rawHeaders = rawHeaders;
  fakeReq.socket.remoteAddress = addr;
  const e = findFast(fakeReq);
  if (e === undefined) return null;
  const t = Date.now();
  const c = rawBuilt(e, t, ep);
  if (c === null) return null;
  if (c.net === null || c.tail !== tail) {
    const h = c.h;
    let head = "HTTP/1.1 200 OK\r\n";
    for (let i = 0; i < h.length; i += 2)
      head += h[i] + ": " + h[i + 1] + "\r\n";
    head +=
      "Date: " + new Date(c.sec * 1000).toUTCString() + "\r\n" + tail + "\r\n";
    const hb = Buffer.from(head, "latin1");
    c.net = Buffer.concat([hb, c.body], hb.length + c.body.length);
    c.tail = tail;
  }
  rawFastStats.hits++;
  return c.net;
}
export function createApp() {
  initialize();
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "extended");
  // Express' weak ETag ("etag" package), with a one-shot SHA-1.
  app.set("etag", (body, encoding) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, encoding);
    return buf.length === 0
      ? 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'
      : 'W/"' +
          buf.length.toString(16) +
          "-" +
          cryptoHash("sha1", buf, "base64").substring(0, 27) +
          '"';
  });
  if (process.env.TRUSTED_PROXIES)
    app.set("trust proxy", process.env.TRUSTED_PROXIES.split(","));
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    next();
  });
  app.use(encodingMiddleware());
  app.use(
    "/assets",
    skip(
      express.static(path.resolve("assets/generated/public/assets"), {
        immutable: true,
        maxAge: "1y",
        dotfiles: "deny",
      }),
    ),
  );
  app.use(
    skip((req, res, next) => {
      if (
        !req.path.startsWith("/rails/active_storage/") &&
        !req.path.startsWith("/webmanifest")
      )
        req.url = req.url.replace(
          /\.(json|turbo_stream)(?=\?|$)/,
          (m, format) => {
            req.format = format;
            return "";
          },
        );
      next();
    }),
  );
  app.use(
    "/rails/active_storage/disk",
    skip(express.raw({ type: () => true, limit: "100mb" })),
  );
  app.use(skip(express.json({ limit: "5mb" })));
  app.use(skip(express.urlencoded({ extended: true, limit: "5mb" })));
  app.use(
    skip((req, res, next) => {
      if (req.is("multipart/form-data"))
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: 100 * 1024 * 1024, files: 20, fields: 1000 },
        }).any()(req, res, next);
      else next();
    }),
  );
  app.use(skip(express.text({ type: "text/plain", limit: "5mb" })));
  app.use(skip(multipartFields));
  app.use(
    skip((req, res, next) => {
      if (
        req.method === "POST" &&
        ["PATCH", "PUT", "DELETE"].includes(
          String(req.body?._method || "").toUpperCase(),
        )
      )
        req.method = req.body._method.toUpperCase();
      next();
    }),
  );
  app.use(sessionMiddleware);
  app.use((req, res, next) => {
    if (cachedBans.has(req.ip)) return res.sendStatus(403);
    if (
      req.authenticatedByBot &&
      !/^\/rooms\/\d+\/[^/]+\/messages(?:\/|$)/.test(req.path)
    )
      return res.sendStatus(403);
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (
      req.authenticatedByBot &&
      /^\/rooms\/\d+\/[^/]+\/messages(?:\/|$)/.test(req.path)
    )
      return next();
    if (
      req.method === "PUT" &&
      req.path.startsWith("/rails/active_storage/disk/")
    ) {
      try {
        const p = rails.verify(
          req.path.split("/").at(-1),
          "ActiveStorage",
          "blob_token",
        );
        if (p && typeof p === "object" && p.key) return next();
      } catch {}
    }
    const origin = req.headers.origin;
    if (origin && origin !== req.protocol + "://" + req.get("host"))
      return res.sendStatus(422);
    if (
      !rails.validCsrf(
        rails.decode64(req.session._csrf_token),
        req.headers["x-csrf-token"] || req.body?.authenticity_token,
        req.path,
        req.method,
      )
    )
      return res.sendStatus(422);
    next();
  });
  app.post("/session", (req, res, next) =>
    allowLogin(req.ip)
      ? next()
      : res.status(429).send("Too many requests or unauthorized."),
  );
  registerStorage(app);
  registerPublic(app);
  registerOpengraph(app);
  registerRoutes(app);
  app.use(
    express.static(path.resolve("assets/generated/public"), {
      dotfiles: "deny",
    }),
  );
  app.use((req, res) => res.sendStatus(404));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error.status) || 500;
    if (status >= 500) console.error(error.stack || error);
    res
      .status(status)
      .send(status >= 500 ? "Internal Server Error" : error.message);
  });
  return app;
}
