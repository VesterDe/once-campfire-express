// Plain net.Server in front of the node:http server. Each new connection
// starts here: complete GET requests whose URL, raw header list and client
// address match a raw fast path entry (src/app.js netFast) are answered with
// one socket.write of a prebuilt response. On the first request that is not
// such a hit (miss, other method, body, upgrade, Connection header other than
// keep-alive, HTTP/1.0, odd header syntax, oversize head) the unread bytes go
// back on the socket and the socket is handed to the http server for the rest
// of its life, so node:http handles it exactly as before.
import net from "node:net";
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
    const onData = (chunk) => {
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
        if (out === null) break;
        if (!corked && buf.length > end + 4) {
          socket.cork();
          corked = true;
        }
        socket.write(out);
        buf = buf.subarray(end + 4);
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
  const close = front.close;
  front.close = function (cb) {
    for (const s of open) s.end();
    open.clear();
    return close.call(this, cb);
  };
  return front;
}
