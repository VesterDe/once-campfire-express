import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
process.env.SECRET_KEY_BASE = "raw-fast-test-secret-".repeat(6);
const temp = mkdtempSync(join(tmpdir(), "campfire-express-raw-fast-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { run, initialize, now } = await import("../src/db.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const { createApp, fastPath, rawFastStats } = await import("../src/app.js");
let server, base, room, users, lastId;
const TOKEN = /(?<=authenticity_token" value="|csrf-token" content=")[^"]*/g;
before(async () => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Cache",
    "join-cache",
    t,
    t,
  );
  users = ["One", "Two"].map((name, i) =>
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
    lastId = domain.createMessage(
      room,
      users[i % 2].id,
      `<p>hello number ${i}</p>`,
    ).id;
  // Same composition as src/server.js: fast path first, then Express.
  const app = createApp();
  server = createServer((req, res) => {
    if (!fastPath(app, req, res)) app(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
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
function raw(path, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
        agent: false,
      },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () =>
          resolve({
            status: r.statusCode,
            raw: r.rawHeaders,
            body: Buffer.concat(chunks),
          }),
        );
      },
    )
      .on("error", reject)
      .end();
  });
}
const isGzip = (r) =>
  r.raw.some(
    (x, i) => i % 2 && /^content-encoding$/i.test(r.raw[i - 1]) && x === "gzip",
  );
// Normalizes what differs per request on either path: Date, the random CSRF
// mask (in the body and the ETag hash) and the cookie Expires second.
function normal(r) {
  const headers = [];
  for (let i = 0; i < r.raw.length; i += 2) {
    const k = r.raw[i].toLowerCase();
    let v = r.raw[i + 1];
    if (k === "date") continue;
    if (k === "etag") v = v.replace(/-[^"]{27}"$/, '-HASH"');
    if (k === "set-cookie") v = v.replace(/Expires=[^;]*/, "Expires=X");
    headers.push(r.raw[i], v);
  }
  const text = (isGzip(r) ? gunzipSync(r.body) : r.body).toString();
  return {
    status: r.status,
    headers,
    size: r.body.length,
    body: text.replace(TOKEN, "TOKEN"),
  };
}
test("raw fast path answers repeats exactly like the Express path", async () => {
  const one = await login("u0@example.test");
  const variants = [
    {},
    { "accept-encoding": "gzip, deflate" },
    { "accept-encoding": "gzip", "turbo-frame": "x" },
    { "accept-encoding": "identity" },
    { "accept-encoding": "gzip", accept: "text/html" },
  ];
  let checked = 0;
  for (const path of [
    `/rooms/${room}`,
    `/rooms/${room}/messages?before=${lastId}`,
    "/users/me/sidebar",
    "/searches?q=hello",
    "/searches",
  ])
    for (const v of variants) {
      const headers = { cookie: one, ...v };
      rawFastStats.enabled = false;
      const slow = await raw(path, headers);
      rawFastStats.enabled = true;
      const hits = rawFastStats.hits;
      const fast = await raw(path, headers);
      const label = path + " " + JSON.stringify(v);
      assert.equal(rawFastStats.hits, hits + 1, label);
      assert.equal(slow.status, 200, label);
      assert.deepEqual(normal(fast), normal(slow), label);
      // Same session cookie value (memoized for 1 s) on both paths.
      const sc = (r) =>
        r.raw
          .filter((x, i) => i % 2 && /^_campfire_session=/.test(x))
          .map((c) => c.split(";")[0]);
      assert.deepEqual(sc(fast), sc(slow), label);
      // Fresh CSRF mask per request; it still unmasks to the session secret.
      const text = (r) => (isGzip(r) ? gunzipSync(r.body) : r.body).toString();
      const tokens = text(fast).match(TOKEN) || [];
      if (!path.includes("/messages") && !path.includes("sidebar")) {
        assert.ok(tokens.length > 0, label);
        assert.notEqual(tokens[0], text(slow).match(TOKEN)[0]);
      }
      assert.ok(new Set(tokens).size <= 1, label);
      checked++;
    }
  assert.equal(checked, 25);
  // A write elsewhere moves the epoch: the next request takes the normal path.
  const outside = new DatabaseSync(join(temp, "db/production.sqlite3"));
  outside.exec(`UPDATE users SET name='Changed' WHERE id=${users[0].id}`);
  outside.close();
  const hits = rawFastStats.hits;
  const changed = await raw(`/rooms/${room}`, { cookie: one });
  assert.equal(rawFastStats.hits, hits);
  assert.ok(changed.body.toString().includes("Changed"));
  // No cookie or a bad cookie is never served raw.
  for (const cookie of [undefined, "session_token=bad"])
    for (let i = 0; i < 2; i++)
      await raw("/users/me/sidebar", cookie ? { cookie } : {});
  assert.equal(rawFastStats.hits, hits);
});
