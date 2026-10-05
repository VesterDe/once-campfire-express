import express from "express";
import compression from "compression";
import multer from "multer";
import path from "node:path";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import * as rails from "./rails.js";
import { get, all, run, now, initialize, epoch } from "./db.js";
import { registerRoutes } from "./routes.js";
import { registerStorage } from "./storage.js";
import { registerPublic } from "./public.js";
import { registerOpengraph } from "./opengraph.js";
import { allowLogin } from "./rate_limit.js";

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
    if (rails.stringify(req.session) !== before)
      res.cookie(
        "_campfire_session",
        rails.encryptCookie("_campfire_session", req.session, expiry),
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
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/;
function encodingMiddleware() {
  const compress = compression();
  return (req, res, next) => {
    const method = contentCoding(req.headers["accept-encoding"]);
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
      if (chunk == null || this.headersSent) {
        res.pageCapture = null;
        return end.call(this, chunk, encoding, callback);
      }
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
      if (res.pageCapture) res.pageCapture(chunk);
      return end.call(this, chunk, callback);
    };
    next();
  }
}
// Whole-response cache for the hot authenticated GET pages. Entries are valid
// only while epoch() is unchanged (no write in any process), and the key holds
// everything the page reads from the request. A hit replays the handler's
// session changes and headers, so cookies are written exactly as on a miss.
const PAGE_LIMIT = 32 * 1024 * 1024;
const PAGE_HEADERS = new Set([
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "content-type",
  "content-length",
  "content-encoding",
  "vary",
]);
const pages = new Map();
let pageBytes = 0,
  pageEpoch = null;
const pageKey = (url, user, session, protocol, h) =>
  [
    url,
    user.id,
    session._csrf_token,
    session.last_room_id ?? "",
    protocol,
    h.host ?? "",
    h["turbo-frame"] ?? "",
    h.accept ?? "",
    h["accept-encoding"] ?? "",
  ].join("\n");
// Raw node:http path for page-cache hits. It only answers when every Express
// layer would be a no-op or act exactly as replayed here (plain HTTP, no
// trusted proxy, GET without body, valid session, fresh activity, not banned,
// cached page). Otherwise it returns false before any side effect and the
// request goes through Express unchanged.
const cookieSerialize = createRequire(
  createRequire(import.meta.url).resolve("express"),
)("cookie").serialize;
// Same as Express res.cookie() for string values.
function expressCookie(name, value, options) {
  const opts = { ...options };
  if (opts.maxAge != null) {
    const maxAge = opts.maxAge - 0;
    if (!isNaN(maxAge)) {
      opts.expires = new Date(Date.now() + maxAge);
      opts.maxAge = Math.floor(maxAge / 1000);
    }
  }
  if (opts.path == null) opts.path = "/";
  return cookieSerialize(name, String(value), opts);
}
export function fastPath(req, res) {
  if (req.method !== "GET" || process.env.TRUSTED_PROXIES) return false;
  const h = req.headers;
  if (
    h["content-length"] !== undefined ||
    h["transfer-encoding"] !== undefined ||
    req.socket.encrypted
  )
    return false;
  const url = req.url,
    q = url.indexOf("?");
  if (!HOT_PATH.test(q < 0 ? url : url.slice(0, q))) return false;
  const coding = contentCoding(h["accept-encoding"]);
  if (coding === "br" || coding === "deflate") return false;
  const cookies = parseCookies(h.cookie);
  let session;
  try {
    session = rails.decryptCookieCached(
      "_campfire_session",
      cookies._campfire_session,
    );
    if (
      !session ||
      typeof session !== "object" ||
      Array.isArray(session) ||
      !session.session_id ||
      rails.decode64(session._csrf_token).length !== 32
    )
      return false;
  } catch {
    return false;
  }
  const e = epoch();
  if (e < 0) return false;
  refreshCaches(e);
  if (pageEpoch !== e || cachedBans.has(req.socket.remoteAddress)) return false;
  const [current, user] = sessionAndUser(cookies);
  if (
    !user ||
    !(
      new Date(current.last_active_at.replace(" ", "T") + "Z").getTime() >=
      Date.now() - 3600000
    )
  )
    return false;
  const hit = pages.get(pageKey(url, user, session, "http", h));
  if (hit === undefined) return false;
  const before = rails.stringify(session);
  for (const [k, v] of hit.session)
    if (v === undefined) delete session[k];
    else session[k] = rails.parseJSON(v);
  // Same cookies, options and order as the sessionMiddleware writeHead hook.
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 20 * 365 * 86400 * 1000,
    path: "/",
  };
  const expiry = new Date(Date.now() + options.maxAge);
  const setCookie = [];
  if (rails.stringify(session) !== before)
    setCookie.push(
      expressCookie(
        "_campfire_session",
        rails.encryptCookie("_campfire_session", session, expiry),
        options,
      ),
    );
  if (hit.lastRoom !== undefined)
    setCookie.push(
      expressCookie("last_room", String(hit.lastRoom), {
        ...options,
        httpOnly: false,
      }),
    );
  res.statusCode = 200;
  for (const [k, v] of hit.headers) res.setHeader(k, v);
  if (setCookie.length)
    res.setHeader(
      "Set-Cookie",
      setCookie.length === 1 ? setCookie[0] : setCookie,
    );
  res.end(hit.body);
  return true;
}
function pageCache(req, res, next) {
  if (
    req.method !== "GET" ||
    !req.user ||
    req.authenticatedByBot ||
    req.format ||
    req.epoch < 0 ||
    !HOT_PATH.test(req.path)
  )
    return next();
  if (pageEpoch !== req.epoch) {
    pages.clear();
    pageBytes = 0;
    pageEpoch = req.epoch;
  }
  const h = req.headers;
  const key = pageKey(req.originalUrl, req.user, req.session, req.protocol, h);
  const hit = pages.get(key);
  if (hit !== undefined) {
    for (const [k, v] of hit.session)
      if (v === undefined) delete req.session[k];
      else req.session[k] = rails.parseJSON(v);
    if (hit.lastRoom !== undefined) req.lastRoom = hit.lastRoom;
    res.statusCode = 200;
    for (const [k, v] of hit.headers) res.setHeader(k, v);
    res.pageCapture = null;
    res.end(hit.body);
    return;
  }
  const before = new Map(
    Object.keys(req.session).map((k) => [k, rails.stringify(req.session[k])]),
  );
  res.pageCapture = (body) => {
    res.pageCapture = null;
    if (
      res.statusCode !== 200 ||
      req.newSessionToken ||
      req.clearSessionToken ||
      res.getHeaderNames().some((n) => !PAGE_HEADERS.has(n)) ||
      epoch() !== req.epoch ||
      pageEpoch !== req.epoch
    )
      return;
    const session = [];
    for (const k of Object.keys(req.session)) {
      const v = rails.stringify(req.session[k]);
      if (before.get(k) !== v) session.push([k, v]);
    }
    for (const k of before.keys())
      if (!(k in req.session)) session.push([k, undefined]);
    const headers = res.getHeaderNames().map((n) => [n, res.getHeader(n)]);
    pageBytes += body.length + key.length;
    pages.set(key, { body, headers, session, lastRoom: req.lastRoom });
    for (const [k, v] of pages) {
      if (pageBytes <= PAGE_LIMIT) break;
      pages.delete(k);
      pageBytes -= v.body.length + k.length;
    }
  };
  next();
}
export function createApp() {
  initialize();
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "extended");
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
  app.set("etag", false);
  app.use(encodingMiddleware());
  app.use(
    "/assets",
    express.static(path.resolve("assets/generated/public/assets"), {
      immutable: true,
      maxAge: "1y",
      dotfiles: "deny",
    }),
  );
  app.use((req, res, next) => {
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
  });
  app.use(
    "/rails/active_storage/disk",
    express.raw({ type: () => true, limit: "100mb" }),
  );
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));
  app.use((req, res, next) => {
    if (req.is("multipart/form-data"))
      multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 100 * 1024 * 1024, files: 20, fields: 1000 },
      }).any()(req, res, next);
    else next();
  });
  app.use(express.text({ type: "text/plain", limit: "5mb" }));
  app.use(multipartFields);
  app.use((req, res, next) => {
    if (
      req.method === "POST" &&
      ["PATCH", "PUT", "DELETE"].includes(
        String(req.body?._method || "").toUpperCase(),
      )
    )
      req.method = req.body._method.toUpperCase();
    next();
  });
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
  app.use(pageCache);
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
