import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
process.env.SECRET_KEY_BASE = "page-hit-test-secret-".repeat(6);
const temp = mkdtempSync(join(tmpdir(), "campfire-express-page-hit-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { run, get, initialize, now } = await import("../src/db.js");
const domain = await import("../src/domain.js");
const { createApp } = await import("../src/app.js");
const { pageHit, cacheEpoch } = await import("../src/rendering.js");
let server, base, host, room, user, lastId;
const TOKEN = /(?<=authenticity_token" value="|csrf-token" content=")[^"]*/g;
before(async () => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Hit",
    "join-hit",
    t,
    t,
  );
  user = domain.createUser({
    name: "One",
    email_address: "one@example.test",
    password: "password",
  });
  room = Number(
    run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      "Lobby",
      "Rooms::Open",
      user.id,
      t,
      t,
    ).lastInsertRowid,
  );
  domain.grantMemberships({ id: room, type: "Rooms::Open" }, [user.id]);
  for (let i = 0; i < 30; i++)
    lastId = domain.createMessage(room, user.id, `<p>hello ${i}</p>`).id;
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${server.address().port}`;
  base = `http://${host}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
});
async function login() {
  let r = await fetch(base + "/session/new");
  const csrf = (await r.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
  const jar = new Map(
    r.headers.getSetCookie().map((c) => c.split(";")[0].split("=")),
  );
  r = await fetch(base + "/session", {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: [...jar].map((p) => p.join("=")).join("; "),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      email_address: "one@example.test",
      password: "password",
      authenticity_token: csrf,
    }),
  });
  for (const c of r.headers.getSetCookie()) {
    const [k, v] = c.split(";")[0].split("=");
    jar.set(k, v);
  }
  return [...jar].map((p) => p.join("=")).join("; ");
}
test("pageHit returns the same page and headers Express sends on a cache hit", async () => {
  const cookie = await login();
  const cases = [
    [`/rooms/${room}`, "room", `${room}|`, room],
    [
      `/rooms/${room}/messages?before=${lastId}`,
      "messages",
      `${room}|` + JSON.stringify([String(lastId), undefined, undefined]),
      room,
    ],
    ["/users/me/sidebar", "sidebar", "", undefined],
    ["/searches?q=hello", "search", "hello", undefined],
  ];
  for (const [path, screen, key, lastRoomId] of cases) {
    const ctx = () => ({
      screen,
      key,
      ep: cacheEpoch(),
      protocol: "http",
      host,
      turboFrame: false,
      lastRoomId,
      user: get("SELECT * FROM users WHERE id=?", user.id),
      csrfToken: "A".repeat(86) + "==",
      acceptEncoding: "gzip",
    });
    const r = await fetch(base + path, {
      headers: { cookie, "accept-encoding": "gzip" },
    });
    assert.equal(r.status, 200, path);
    const html = (await r.text()).replace(TOKEN, "T");
    const hit = pageHit(ctx());
    assert.ok(hit, path);
    const h = new Map();
    for (let i = 0; i < hit.headers.length; i += 2)
      h.set(hit.headers[i].toLowerCase(), hit.headers[i + 1]);
    assert.equal(h.get("content-type"), r.headers.get("content-type"), path);
    assert.equal(
      h.get("content-encoding"),
      r.headers.get("content-encoding") ?? undefined,
      path,
    );
    assert.equal(Number(h.get("content-length")), hit.body.length, path);
    const body = (
      h.get("content-encoding") === "gzip" ? gunzipSync(hit.body) : hit.body
    ).toString();
    assert.equal(body.replace(TOKEN, "T"), html, path);
    if (/csrf-token|authenticity_token/.test(body))
      assert.ok(body.includes("A".repeat(86) + "=="), path);
    if (screen !== "messages")
      assert.equal(
        pageHit({ ...ctx(), user: { ...ctx().user, name: "Other" } }),
        null,
        path,
      );
  }
});
