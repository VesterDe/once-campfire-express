import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
process.env.SECRET_KEY_BASE = "page-cache-test-secret-".repeat(6);
const temp = mkdtempSync(join(tmpdir(), "campfire-express-page-cache-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { run, initialize, now } = await import("../src/db.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const { createApp, fastPath } = await import("../src/app.js");
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
function get(path, headers) {
  return new Promise((resolve, reject) =>
    fetch(base + path, { headers, redirect: "manual" })
      .then(async (r) => {
        const raw = Buffer.from(await r.arrayBuffer());
        const headers = [...r.headers].filter(
          ([k]) => !["date", "set-cookie", "etag"].includes(k),
        );
        const cookies = r.headers.getSetCookie().map((c) => {
          const [nv, ...attrs] = c.split("; ");
          const [name, value] = nv.split("=");
          return [
            name,
            name === "_campfire_session"
              ? rails.decryptCookie(name, decodeURIComponent(value))
              : value,
            attrs.filter((a) => !a.startsWith("Expires=")),
          ];
        });
        resolve({
          status: r.status,
          headers,
          cookies,
          body: raw.toString().replace(TOKEN, "TOKEN"),
        });
      })
      .catch(reject),
  );
}
test("lean fast-path router repeats responses per user and sees writes from other connections", async () => {
  const one = await login("u0@example.test"),
    two = await login("u1@example.test");
  for (const path of [
    `/rooms/${room}`,
    `/rooms/${room}/messages?before=${lastId}`,
    "/users/me/sidebar",
    "/searches?q=hello",
  ]) {
    const first = await get(path, { cookie: one });
    assert.equal(first.status, 200, path);
    const again = await get(path, { cookie: one });
    assert.deepEqual(again, first, path);
    const other = await get(path, { cookie: two });
    assert.equal(other.status, 200);
    if (path === `/rooms/${room}`) {
      assert.ok(
        first.body.includes(`current-user-id" content="${users[0].id}`),
      );
      assert.ok(
        other.body.includes(`current-user-id" content="${users[1].id}`),
      );
      assert.equal(first.cookies[0][1].last_room_id, room);
      assert.deepEqual(first.cookies[1].slice(0, 2), [
        "last_room",
        String(room),
      ]);
    }
    assert.deepEqual(await get(path, { cookie: two }), other, path);
  }
  const gz = await fetch(base + `/rooms/${room}`, {
    headers: { cookie: one, "accept-encoding": "gzip" },
  });
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  // Every page gets a freshly masked CSRF token, as in Rails.
  const tokens = new Set();
  for (let i = 0; i < 3; i++) {
    const html = await (
      await fetch(base + `/rooms/${room}`, {
        headers: { cookie: one, "accept-encoding": "gzip" },
      })
    ).text();
    tokens.add(html.match(/name="csrf-token" content="([^"]+)"/)[1]);
  }
  assert.equal(tokens.size, 3);
  // A write through another SQLite connection invalidates the cache.
  const outside = new DatabaseSync(join(temp, "db/production.sqlite3"));
  outside.exec(`UPDATE users SET name='Renamed One' WHERE id=${users[0].id}`);
  outside.close();
  const changed = await get(`/rooms/${room}`, { cookie: one });
  assert.ok(changed.body.includes("Renamed One"));
  // A ban written elsewhere applies immediately.
  const banning = new DatabaseSync(join(temp, "db/production.sqlite3"));
  banning.exec(
    `INSERT INTO bans(user_id,ip_address,created_at,updated_at) VALUES(${users[1].id},'127.0.0.1','${now()}','${now()}')`,
  );
  assert.equal((await get(`/rooms/${room}`, { cookie: one })).status, 403);
  banning.exec("DELETE FROM bans");
  banning.close();
  assert.equal((await get(`/rooms/${room}`, { cookie: one })).status, 200);
});
// The kept ETag of a token-less gzip page is the SHA-1 of the bytes sent,
// on a repeat and after a write from another connection.
test("token-less gzip page ETag matches its body across repeats and writes", async () => {
  const one = await login("u0@example.test");
  const { request } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const path = `/rooms/${room}/messages?before=${lastId}`;
  const raw = () =>
    new Promise((resolve, reject) =>
      request(
        base + path,
        { headers: { cookie: one, "accept-encoding": "gzip" } },
        (m) => {
          const chunks = [];
          m.on("data", (c) => chunks.push(c));
          m.on("end", () =>
            resolve({ etag: m.headers.etag, body: Buffer.concat(chunks) }),
          );
        },
      )
        .on("error", reject)
        .end(),
    );
  const expected = (b) =>
    `W/"${b.length.toString(16)}-${createHash("sha1").update(b).digest("base64").slice(0, 27)}"`;
  const a = await raw(),
    b = await raw();
  assert.equal(a.etag, expected(a.body));
  assert.equal(b.etag, a.etag);
  assert.deepEqual(b.body, a.body);
  const outside = new DatabaseSync(join(temp, "db/production.sqlite3"));
  outside.exec(`UPDATE users SET name='Etag Renamed' WHERE id=${users[1].id}`);
  outside.close();
  const c = await raw();
  assert.ok(gunzipSync(c.body).toString().includes("Etag Renamed"));
  assert.notEqual(c.etag, a.etag);
  assert.equal(c.etag, expected(c.body));
});
