import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import net from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
process.env.SECRET_KEY_BASE = "net-front-test-secret-".repeat(6);
const temp = mkdtempSync(join(tmpdir(), "campfire-express-net-front-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { run, initialize, now } = await import("../src/db.js");
const domain = await import("../src/domain.js");
const { createApp, fastPath, rawFastStats } = await import("../src/app.js");
const { attachCable } = await import("../src/cable.js");
const { createFront } = await import("../src/netfront.js");
let server, front, base, room;
before(async () => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Net",
    "join-net",
    t,
    t,
  );
  const users = ["One", "Two"].map((name, i) =>
    domain.createUser({
      name,
      email_address: `u${i}@example.test`,
      password: "password",
    }),
  );
  const r = run(
    "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
    "Lobby",
    "Rooms::Open",
    users[0].id,
    t,
    t,
  );
  room = Number(r.lastInsertRowid);
  domain.grantMemberships({ id: room, type: "Rooms::Open" }, [
    users[0].id,
    users[1].id,
  ]);
  for (let i = 0; i < 30; i++)
    domain.createMessage(room, users[i % 2].id, `<p>hello number ${i}</p>`);
  // Same composition as src/server.js: net front, then node:http + Express.
  const app = createApp();
  server = createServer((req, res) => {
    if (!fastPath(app, req, res)) app(req, res);
  });
  attachCable(server);
  front = createFront(server);
  front.on("listening", () => server.emit("listening"));
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${front.address().port}`;
});
after(async () => {
  server.close();
  server.closeAllConnections();
  await new Promise((resolve) => front.close(resolve));
  rmSync(temp, { recursive: true, force: true });
});
async function login(email) {
  let response = await fetch(base + "/session/new");
  const csrf = (await response.text()).match(
    /name="csrf-token" content="([^"]+)"/,
  )[1];
  const jar = new Map(
    response.headers.getSetCookie().map((c) => c.split(";")[0].split("=")),
  );
  response = await fetch(base + "/session", {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: [...jar].map((p) => p.join("=")).join("; "),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      email_address: email,
      password: "password",
      authenticity_token: csrf,
    }),
  });
  assert.equal(response.status, 302);
  for (const c of response.headers.getSetCookie()) {
    const [k, v] = c.split(";")[0].split("=");
    jar.set(k, v);
  }
  return [...jar].map((p) => p.join("=")).join("; ");
}
// Raw TCP client: collects whole responses (Content-Length framed).
function conn() {
  const s = net.connect(Number(new URL(base).port), "127.0.0.1");
  s.setNoDelay(true);
  let buf = Buffer.alloc(0),
    closed = false;
  const waiters = [],
    responses = [];
  const pump = () => {
    for (;;) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) break;
      const m = /\r\ncontent-length: (\d+)/i.exec(buf.latin1Slice(0, end));
      const len = m ? Number(m[1]) : 0;
      if (buf.length < end + 4 + len) break;
      responses.push(buf.subarray(0, end + 4 + len));
      buf = buf.subarray(end + 4 + len);
    }
    while (waiters.length && (responses.length >= waiters[0].n || closed))
      waiters.shift().resolve();
  };
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });
  s.on("error", () => {});
  s.on("close", () => {
    closed = true;
    pump();
  });
  return {
    s,
    responses,
    get closed() {
      return closed;
    },
    send: (text) => s.write(text),
    wait: (n) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 3000);
        waiters.push({
          n,
          resolve: () => {
            clearTimeout(t);
            resolve();
          },
        });
        pump();
      }),
  };
}
const req = (path, cookie, extra = "") =>
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n` +
  `Accept-Encoding: gzip\r\nSec-Fetch-Site: same-origin\r\n${extra}\r\n`;
const statusOf = (b) => Number(b.latin1Slice(9, 12));
const headOf = (b) => b.latin1Slice(0, b.indexOf("\r\n\r\n"));
const ODD = "GET /up HTTP/1.1\r\nHost: x\r\nX-Pad: y \r\n\r\n";
const dateOf = (b) => /\r\nDate: ([^\r]*)/.exec(headOf(b))[1];
test("net front: hits, byte parity, keep-alive, miss hand-off", async () => {
  const cookie = await login("u0@example.test");
  const path = `/rooms/${room}`;
  for (let round = 0; round < 5; round++) {
    // Socket a: a first request the front does not parse (trailing space in
    // a header value) hands it to node:http for good; then a miss records.
    const a = conn();
    a.send(ODD + req(path, cookie));
    await a.wait(2);
    assert.equal(statusOf(a.responses[1]), 200);
    // Fresh socket: two pipelined repeats in one write, then one more split
    // over two writes, all answered by the front on one keep-alive socket.
    const hits = rawFastStats.hits;
    const b = conn();
    b.send(req(path, cookie) + req(path, cookie));
    await b.wait(2);
    b.send(req(path, cookie).slice(0, 20));
    await new Promise((r) => setTimeout(r, 20));
    b.send(req(path, cookie).slice(20));
    await b.wait(3);
    assert.equal(rawFastStats.hits, hits + 3);
    for (const r of b.responses) assert.equal(statusOf(r), 200);
    // Socket a now belongs to node:http; its repeat uses rawFast there.
    a.send(req(path, cookie));
    await a.wait(3);
    assert.equal(rawFastStats.hits, hits + 4);
    const s1 = b.responses[2],
      s2 = a.responses[2];
    a.s.destroy();
    if (dateOf(s1) !== dateOf(s2)) {
      b.s.destroy();
      continue;
    }
    // Same clock second: the front's bytes equal node:http's bytes.
    assert.equal(headOf(s1), headOf(s2));
    assert.ok(s1.equals(s2));
    // A miss after hits is served in place; the front keeps the socket and
    // the next repeat is a front hit again. Then an odd head hands it off.
    const h2 = rawFastStats.hits;
    b.send(`GET /nope HTTP/1.1\r\nHost: x\r\n\r\n` + req(path, cookie));
    await b.wait(5);
    assert.equal(statusOf(b.responses[3]), 404);
    assert.equal(statusOf(b.responses[4]), 200);
    assert.equal(rawFastStats.hits, h2 + 1);
    b.send(ODD + req(path, cookie));
    await b.wait(7);
    assert.equal(statusOf(b.responses[6]), 200);
    assert.ok(!b.closed);
    b.s.destroy();
    return;
  }
  assert.fail("no same-second sample");
});
test("net front: a miss served in place matches node:http", async () => {
  const cookie = await login("u1@example.test");
  const names = (b) =>
    headOf(b)
      .split("\r\n")
      .map((l, i) => (i ? l.split(":")[0] : l));
  const f = conn();
  f.send(req("/searches?q=hello", cookie));
  await f.wait(1);
  const h = conn();
  h.send(ODD + req("/searches?q=number", cookie));
  await h.wait(2);
  assert.deepEqual(names(f.responses[0]), names(h.responses[1]));
  const hits = rawFastStats.hits;
  f.send(req("/searches?q=hello", cookie));
  await f.wait(2);
  assert.equal(rawFastStats.hits, hits + 1);
  assert.equal(statusOf(f.responses[1]), 200);
  // Many misses in place on one socket leave no listeners behind.
  for (let i = 0; i < 20; i++) f.send(req("/searches?q=x" + i, cookie));
  await f.wait(22);
  for (const r of f.responses) assert.equal(statusOf(r), 200);
  const [srv] = [...front.sockets()];
  for (const ev of ["close", "error", "end", "finish", "drain"])
    assert.ok(srv.listenerCount(ev) <= 3, ev + " " + srv.listenerCount(ev));
  for (const x of [f, h]) x.s.destroy();
});
test("net front: Connection: close and HTTP/1.0 go to node:http", async () => {
  const cookie = await login("u1@example.test");
  const path = "/users/me/sidebar";
  const a = conn();
  a.send(ODD + req(path, cookie));
  await a.wait(2);
  const hits = rawFastStats.hits;
  const c = conn();
  c.send(req(path, cookie, "Connection: close\r\n"));
  await c.wait(1);
  if (!c.closed) await once(c.s, "close");
  assert.equal(statusOf(c.responses[0]), 200);
  assert.match(headOf(c.responses[0]), /\r\nConnection: close/i);
  const d = conn();
  d.send(req(path, cookie).replace("HTTP/1.1", "HTTP/1.0"));
  await d.wait(1);
  assert.equal(statusOf(d.responses[0]), 200);
  // The HTTP/1.0 repeat is a rawFast hit inside node:http, not in the front.
  assert.equal(rawFastStats.hits, hits + 1);
  assert.match(headOf(d.responses[0]), /\r\nConnection: close/i);
  for (const x of [a, d]) x.s.destroy();
});
test("net front: websocket upgrade reaches the cable server", async () => {
  const cookie = await login("u0@example.test");
  const ws = new WebSocket(
    base.replace("http", "ws") + "/cable",
    ["actioncable-v1-json"],
    { headers: { Cookie: cookie } },
  );
  const frame = await new Promise((resolve, reject) => {
    ws.on("message", (raw) => resolve(JSON.parse(raw)));
    ws.on("error", reject);
  });
  assert.equal(frame.type, "welcome");
  ws.close();
});
test("net front: POST with a body is handed off", async () => {
  const c = conn();
  c.send(
    "POST /session HTTP/1.1\r\nHost: x\r\n" +
      "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: 3\r\n\r\na=b",
  );
  await c.wait(1);
  assert.equal(statusOf(c.responses[0]), 422);
  c.s.destroy();
});
