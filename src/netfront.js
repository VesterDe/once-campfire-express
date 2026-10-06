// Plain net.Server in front of the node:http server. Each new connection
// starts here: complete GET requests whose URL, raw header list and client
// address match a raw fast path entry (src/app.js netFast) are answered with
// one socket.write of a prebuilt response. On the first request that is not
// such a hit (miss, other method, body, upgrade, Connection header other than
// keep-alive, HTTP/1.0, odd header syntax, oversize head) the unread bytes go
// back on the socket and the socket is handed to the http server for the rest
// of its life, so node:http handles it exactly as before.
import net from "node:net";
import { IncomingMessage, ServerResponse } from "node:http";
import { netFast } from "./app.js";
import { epoch } from "./db.js";

const HEADER =
  /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*([\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?)$/;
const URL_OK = /^\/[\x21-\x7e]*$/;
const MAX_HEAD = 16384;
// Parsed request heads, keyed by the head text (request line + headers).
// null = not eligible (always hand off).
const heads = new Map();
function parseHead(text) {
  const lines = text.split("\r\n");
  const first = lines[0];
  if (!first.startsWith("GET ") || !first.endsWith(" HTTP/1.1")) return null;
  const url = first.slice(4, -9);
  if (!URL_OK.test(url)) return null;
  const raw = [];
  for (let i = 1; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (m === null) return null;
    const lower = m[1].toLowerCase();
    if (
      lower === "content-length" ||
      lower === "transfer-encoding" ||
      lower === "upgrade" ||
      lower === "expect" ||
      (lower === "connection" && m[2].toLowerCase() !== "keep-alive")
    )
      return null;
    raw.push(m[1], m[2]);
  }
  return { url, raw };
}
function lookupHead(text) {
  let p = heads.get(text);
  if (p === undefined) {
    p = parseHead(text);
    if (heads.size >= 2000) heads.clear();
    heads.set(text, p);
  }
  return p;
}

export function createFront(httpServer) {
  const open = new Set();
  const front = net.createServer({ noDelay: true }, (socket) => {
    open.add(socket);
    let pending = null;
    const addr = socket.remoteAddress;
    const idle = httpServer.keepAliveTimeout;
    if (idle > 0) socket.setTimeout(idle);
    const handOff = (rest) => {
      socket.removeListener("data", onData);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.setTimeout(0);
      open.delete(socket);
      if (rest !== null && rest.length) socket.unshift(rest);
      httpServer.emit("connection", socket);
    };
    // A front-eligible GET that is not a hit is served on this same socket
    // through the http server's request handler with node's own
    // IncomingMessage/ServerResponse (the same objects node:http builds for
    // a parsed GET without body); the front reads the socket again after the
    // response finishes. Bytes arriving meanwhile wait in `pending`.
    let busy = false;
    const serveMiss = (p) => {
      busy = true;
      socket.setTimeout(0);
      const req = new IncomingMessage(socket);
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;
      req.httpVersion = "1.1";
      req.method = "GET";
      req.url = p.url;
      req._addHeaderLines(p.raw.slice(), p.raw.length);
      req.complete = true;
      req.push(null);
      const res = new ServerResponse(req);
      res._keepAliveTimeout = httpServer.keepAliveTimeout;
      res.shouldKeepAlive = true;
      res.assignSocket(socket);
      res.on("finish", () => {
        res.detachSocket(socket);
        process.nextTick(() => res.emit("close"));
        busy = false;
        if (res._last || socket.destroyed) {
          socket.destroySoon();
          return;
        }
        const kat = httpServer.keepAliveTimeout;
        if (kat > 0) socket.setTimeout(kat);
        if (pending !== null) {
          const b = pending;
          pending = null;
          onData(b);
        }
      });
      try {
        httpServer.emit("request", req, res);
      } catch (error) {
        console.error(error);
        socket.destroy();
      }
    };
    const onData = (chunk) => {
      if (busy) {
        pending = pending === null ? chunk : Buffer.concat([pending, chunk]);
        return;
      }
      let buf = pending === null ? chunk : Buffer.concat([pending, chunk]);
      pending = null;
      const kat = httpServer.keepAliveTimeout;
      if (httpServer.maxRequestsPerSocket > 0) return handOff(buf);
      const tail =
        "Connection: keep-alive\r\n" +
        (kat > 0
          ? "Keep-Alive: timeout=" + Math.floor(kat / 1000) + "\r\n"
          : "");
      let ep = -2,
        corked = false;
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buf.length > MAX_HEAD) break;
          if (buf.length) pending = buf;
          if (corked) socket.uncork();
          return;
        }
        const p = lookupHead(buf.latin1Slice(0, end));
        if (p === null) break;
        if (ep === -2) ep = epoch();
        const out = netFast(p.url, p.raw, addr, tail, ep);
        const rest = buf.subarray(end + 4);
        if (out === null) {
          if (corked) socket.uncork();
          if (rest.length) pending = rest;
          serveMiss(p);
          return;
        }
        if (!corked && rest.length) {
          socket.cork();
          corked = true;
        }
        socket.write(out);
        buf = rest;
        if (!buf.length) {
          if (corked) socket.uncork();
          return;
        }
      }
      if (corked) socket.uncork();
      handOff(buf);
    };
    const onTimeout = () => socket.destroy();
    const onError = () => socket.destroy();
    const onClose = () => open.delete(socket);
    socket.on("data", onData);
    socket.on("timeout", onTimeout);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
  front.sockets = () => open;
  const close = front.close;
  front.close = function (cb) {
    for (const s of open) s.end();
    open.clear();
    return close.call(this, cb);
  };
  return front;
}
