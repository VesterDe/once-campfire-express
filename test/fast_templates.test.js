// The hand-written builders in src/fast_templates.js must give the same bytes
// as the nunjucks macros in templates/pages.html for the same `dot` data.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nunjucks from "nunjucks";
process.env.SECRET_KEY_BASE = "fast-templates-secret-".repeat(6);
const temp = mkdtempSync(join(tmpdir(), "campfire-express-fasttpl-"));
process.env.CAMPFIRE_STORAGE_PATH = temp;
const { all, get, run, initialize, now } = await import("../src/db.js");
const domain = await import("../src/domain.js");
const rails = await import("../src/rails.js");
const R = await import("../src/rendering.js");
const F = await import("../src/fast_templates.js");
const safe = (v) => new nunjucks.runtime.SafeString(v);

const odd = `Zoë "Q" O'Brien \\ <b>&amp; \`tick\``;
let users = [],
  rooms = {},
  ids = [];
function same(name, dot, fast = F.fast[name]) {
  const want = R.fragment(name, dot);
  const got = fast(dot);
  if (got !== want) {
    let i = 0;
    while (got[i] === want[i]) i++;
    assert.fail(
      `${name} differs at ${i}\nnunjucks: ${JSON.stringify(want.slice(Math.max(0, i - 120), i + 120))}\nfast:     ${JSON.stringify(got.slice(Math.max(0, i - 120), i + 120))}`,
    );
  }
  return want;
}

before(() => {
  initialize();
  const t = now();
  run(
    "INSERT INTO accounts(name,join_code,created_at,updated_at) VALUES(?,?,?,?)",
    "Fast & <Furious>",
    "join-me",
    t,
    t,
  );
  const names = [
    "Admin Person",
    odd,
    "Plain",
    "Émile Zola-Ünïcode 名前",
    "Back\\slash Name",
    "Inactive Person",
    "x",
    "Seven Eight Nine",
  ];
  names.forEach((name, i) =>
    users.push(
      domain.createUser({
        name,
        email_address: `u${i}@example.test`,
        password: "pw",
        role: i === 0 ? 1 : 0,
      }),
    ),
  );
  users.push(
    domain.createUser({ name: `Bot "<Robo>"`, role: 2, bot_token: "tok" }),
  );
  run("UPDATE users SET status=1 WHERE id=?", users[5].id);
  run(
    "UPDATE users SET bio=? WHERE id=?",
    `Bio with "quotes" & <tags> \\`,
    users[1].id,
  );
  const mk = (name, type, members) => {
    const r = run(
      "INSERT INTO rooms(name,type,creator_id,created_at,updated_at) VALUES(?,?,?,?,?)",
      name,
      type,
      users[0].id,
      t,
      t,
    );
    const room = get(
      "SELECT * FROM rooms WHERE id=?",
      Number(r.lastInsertRowid),
    );
    domain.grantMemberships(
      room,
      members.map((u) => u.id),
    );
    return room;
  };
  rooms.open = get(
    "SELECT * FROM rooms WHERE id=?",
    mk(`Open <"Room"> & 'co' \\`, "Rooms::Open", users).id,
  );
  rooms.closed = mk("Closed", "Rooms::Closed", [users[0], users[1], users[2]]);
  rooms.empty = mk(null, "Rooms::Open", [users[0]]);
  rooms.direct1 = mk(null, "Rooms::Direct", [users[0], users[1]]);
  rooms.direct3 = mk(null, "Rooms::Direct", [
    users[0],
    users[1],
    users[2],
    users[3],
  ]);
  rooms.direct7 = mk(null, "Rooms::Direct", users.slice(0, 8));
  rooms.self = mk(null, "Rooms::Direct", [users[0]]);
  run(
    "UPDATE memberships SET unread_at=? WHERE room_id IN (?,?) AND user_id=?",
    t,
    rooms.closed.id,
    rooms.direct3.id,
    users[0].id,
  );

  const mention = (u) =>
    `<action-text-attachment sgid="${rails.sgid("User", u.id)}" content-type="application/vnd.campfire.mention"></action-text-attachment>`;
  const bodies = [
    "<p>hello</p>",
    `<p>Hey ${mention(users[1])} and ${mention(users[4])} look</p>`,
    `<p>one</p><ul><li>a</li><li>b &amp; c</li></ul><ol><li>x</li></ol>`,
    `<p>See <a href="https://example.com/?a=1&amp;b=2">link</a> <strong>bold</strong> <em>em</em></p>`,
    "<p>👍🎉</p>",
    "<p>🔥</p>",
    `<p>quotes " ' \\ &lt;script&gt;alert(1)&lt;/script&gt;</p>`,
    `<pre>code\n  block</pre><blockquote>quoted</blockquote>`,
    "",
    "<p>42</p>",
  ];
  let k = 0;
  for (const room of [rooms.open, rooms.closed, rooms.direct1, rooms.direct3]) {
    const members = all(
      "SELECT user_id FROM memberships WHERE room_id=?",
      room.id,
    ).map((r) => r.user_id);
    for (const body of bodies) {
      const m = domain.createMessage(
        room.id,
        members[k++ % members.length],
        body,
      );
      ids.push(m.id);
    }
  }
  // Bot message, then a message per attachment kind.
  ids.push(
    domain.createMessage(rooms.open.id, users[8].id, "<p>beep from bot</p>").id,
  );
  const files = [
    ['photo "one" & <two>.png', "image/png"],
    ["scan's.pdf", "application/pdf"],
    ["clip\\back.mp4", "video/mp4"],
    ["notes.txt", "text/plain"],
    ["no-type.bin", null],
    ["ünïcode file.jpeg", "image/jpeg"],
  ];
  files.forEach(([filename, type], i) => {
    const m = domain.createMessage(rooms.open.id, users[i % 3].id, "");
    const b = run(
      "INSERT INTO active_storage_blobs(byte_size,checksum,content_type,created_at,filename,key,metadata,service_name) VALUES(?,?,?,?,?,?,?,?)",
      10,
      "x",
      type,
      t,
      filename,
      "key" + i + "abcdefgh",
      "{}",
      "local",
    );
    run(
      "INSERT INTO active_storage_attachments(blob_id,created_at,name,record_id,record_type) VALUES(?,?,?,?,?)",
      Number(b.lastInsertRowid),
      t,
      "attachment",
      m.id,
      "Message",
    );
    ids.push(m.id);
  });
  // Boosts: emoji, text, special characters, several per message.
  const boostOn = (mid, u, content) =>
    run(
      "INSERT INTO boosts(message_id,booster_id,content,created_at,updated_at) VALUES(?,?,?,?,?)",
      mid,
      u.id,
      content,
      t,
      t,
    );
  boostOn(ids[0], users[1], "👍");
  boostOn(ids[0], users[2], "nice!");
  boostOn(ids[0], users[3], `<"&'\\>`);
  boostOn(ids[1], users[5], "🎉🔥");
  boostOn(ids[3], users[8], "12");
  boostOn(ids.at(-1), users[1], "ok 👍");
  // Odd timestamps the epoch()/iso() helpers must handle the same way.
  run(
    "UPDATE messages SET created_at=?, updated_at=? WHERE id=?",
    "2026-01-02T03:04:05.678Z",
    "2026-01-02 03:04:05",
    ids[2],
  );
  run(
    "UPDATE users SET updated_at=? WHERE id=?",
    "2025-12-31 23:59:59.999999",
    users[2].id,
  );
});

const allMessages = () =>
  R.messageData(
    ids.map((id) => domain.messageById(id)),
    "http://example.test:3000",
  );

test("message macro tree matches nunjucks for every seeded message", () => {
  const data = allMessages();
  assert.ok(data.length >= 47);
  assert.ok(data.some((d) => d.Attachment));
  assert.ok(data.some((d) => d.AllEmoji));
  assert.ok(data.some((d) => d.Boosts.length > 2));
  for (const d of data) {
    same("message", d);
    same("message_uncached", d);
    same("message_actions", d);
    same("presentation", d);
    same("boosts", d);
    for (const b of d.Boosts) same("boost", b);
  }
  same("messages", { Messages: data });
});

test("message edge values follow nunjucks printing rules", () => {
  const [d] = allMessages();
  const cases = [
    { ...d, Fragment: safe("<p>cached</p>") },
    { ...d, Fragment: "<p>plain string is escaped</p>" },
    { ...d, HTML: "<b>not safe</b>" },
    { ...d, HTML: null, ClientID: null, RoomName: undefined, Creator: 0 },
    {
      ...d,
      ID: 1.5,
      CreatorID: true,
      AllEmoji: "yes",
      Attachment: { Filename: null },
    },
    { ...d, Boosts: [], Permalink: `a"b'c<d>&e\\f` },
  ];
  for (const c of cases) same("message", c);
  same("messages", { MessagesHTML: safe("<div>pre-rendered</div>") });
  same("messages", { MessagesHTML: "<div>escaped</div>" });
  same("messages", { Messages: [] });
  same("messages", {});
});

function sidebarDot(user) {
  const rows = domain.roomsForUser(user.id);
  rows.sort((a, b) =>
    a.type === "Rooms::Direct" && b.type === "Rooms::Direct"
      ? b.updated_at.localeCompare(a.updated_at)
      : a.type === "Rooms::Direct"
        ? -1
        : b.type === "Rooms::Direct"
          ? 1
          : (a.name || "").localeCompare(b.name || ""),
  );
  return {
    User: R.userData(user),
    RoomsStream: rails.signStream("rooms"),
    UserRoomsStream: `stream-"${user.id}"`,
    CanCreateRooms: user.role === 1,
    SidebarRooms: rows.map((r) => ({
      ...R.roomData(r, user),
      Unread: !!r.unread_at,
    })),
    Placeholders: [],
  };
}

test("sidebar macros match nunjucks for each user", () => {
  for (const id of users.map((u) => u.id)) {
    const user = domain.userById(id);
    const dot = sidebarDot(user);
    same("sidebar", dot);
    for (const r of dot.SidebarRooms)
      same(r.Type === "Rooms::Direct" ? "sidebar_direct" : "sidebar_shared", r);
  }
  const admin = domain.userById(users[0].id);
  const dot = sidebarDot(admin);
  assert.ok(dot.SidebarRooms.some((r) => r.Members.length > 4));
  assert.ok(dot.SidebarRooms.some((r) => r.Unread));
  same("sidebar", {
    ...dot,
    CanCreateRooms: false,
    Placeholders: users.map(R.userData),
  });
  same("sidebar", { ...dot, User: R.userData(null), SidebarRooms: [] });
});

// Same top-level data that rendering.render() builds for a screen.
function pageDot(user, screen, extra = {}) {
  const account = get("SELECT * FROM accounts LIMIT 1");
  return {
    User: R.userData(user),
    Account: {
      ID: account.id,
      Name: account.name,
      JoinCode: account.join_code,
      UpdatedAt: account.updated_at,
      HasLogo: false,
      RestrictRooms: false,
      RestrictRoomCreation: false,
    },
    Screen: screen,
    BodyClass:
      screen === "search"
        ? "sidebar searches"
        : ["room", "welcome"].includes(screen)
          ? "sidebar"
          : screen,
    Title: "Campfire",
    Frame: false,
    Origin: "http://example.test:3000",
    CSRF: "csrf",
    Version: "once-campfire-express",
    VAPIDPublicKey: "vapid<key>",
    CustomStyles: safe(""),
    Messages: [],
    RecentSearches: [],
    RoomsStream: rails.signStream("rooms"),
    UserRoomsStream: "user-stream",
    CanCreateRooms: true,
    Notice: "",
    Error: "",
    Reload: false,
    Chat: screen === "room",
    ReturnRoom: "",
    Query: "",
    ...extra,
  };
}

test("room page matches nunjucks", () => {
  const admin = domain.userById(users[0].id);
  const other = domain.userById(users[1].id);
  for (const [name, room] of Object.entries(rooms)) {
    for (const user of [admin, other]) {
      if (!domain.roomForUser(user, room.id)) continue;
      const roomRow = domain.roomForUser(user, room.id);
      const dot = pageDot(user, "room", {
        Room: R.roomData(roomRow, user),
        Messages: R.messageData(
          domain.messagesForRoom(room.id),
          "http://example.test:3000",
        ),
        LoadedAt: R.epoch(roomRow.updated_at),
        Stream: rails.signStream(rails.stream(roomRow)),
        Involvement: "mentions",
        Invitation: name === "empty",
      });
      same("room", dot);
    }
  }
  const roomRow = domain.roomForUser(admin, rooms.open.id);
  const base = pageDot(admin, "room", {
    Room: R.roomData(roomRow, admin),
    Messages: R.messageData(domain.messagesForRoom(rooms.open.id)),
    LoadedAt: 0,
    Stream: "s",
  });
  const variants = [
    { Frame: true },
    { Notice: `Saved "it" & <done>` },
    { Error: "Bad 'thing'" },
    { Notice: "n", Error: "e" },
    { Account: { ...base.Account, HasLogo: true } },
    { Title: "", Reload: true, CustomStyles: safe("<style>body{}</style>") },
    { Title: `T<"i">tle`, CustomStyles: "<style>escaped</style>" },
    {
      User: R.userData(other),
      Platform: { Chrome: true, Android: true, Browser: "Chrome" },
    },
    {
      Platform: {
        Safari: true,
        IOS: true,
        Browser: "Safari",
        OperatingSystem: "iOS",
      },
    },
    {
      Platform: {
        Firefox: true,
        Desktop: true,
        Windows: true,
        Browser: "Firefox",
      },
    },
    { MessagesHTML: safe("<div>cached messages</div>") },
  ];
  for (const v of variants) same("room", { ...base, ...v });
  // The optional second argument takes prebuilt messages markup.
  assert.equal(F.room(base, F.messages(base)), R.fragment("room", base));
});

test("layout start and end match nunjucks on other screens", () => {
  const admin = domain.userById(users[0].id);
  const screens = [
    ["welcome", {}],
    ["join", { User: R.userData(null), JoinCode: "join-me" }],
    ["user", { Subject: R.userData(admin) }],
    ["user", { Subject: R.userData(domain.userById(users[1].id)) }],
    ["bots", {}],
    ["custom-styles", {}],
    ["bot-form", {}],
    ["push-subscriptions", { BackPath: `/back?a=1&b="2"` }],
    ["room-form", { Room: { ID: 0, Type: "Rooms::Direct" }, BackPath: "/" }],
    ["room-form", { Room: { ID: 0, Type: "Rooms::Open" }, BackPath: "/x" }],
    ["account", { BackPath: "/" }],
    ["profile", {}],
    ["search", { Query: `q "x" & y`, RecentSearches: ["a", "b<c>"] }],
    ["login", { User: R.userData(null), Frame: true }],
  ];
  for (const [screen, extra] of screens) {
    const dot = pageDot(admin, screen, extra);
    same("layout_start", dot);
    same("layout_end", dot);
  }
});

test("search page builders match the nunjucks macros", () => {
  const admin = domain.userById(users[0].id);
  const names = ["search", "search_nav", "recent_searches", "search_composer"];
  const rows = ids.map((id) => domain.messageById(id));
  const dots = [
    {},
    { Query: `q "x" & y`, RecentSearches: ["a", "b<c>", odd] },
    { Query: "coffee", RecentSearches: [], Messages: rows, ReturnRoom: 7 },
    { Query: "", RecentSearches: null, MessagesHTML: safe("<i>marked</i>") },
    { Query: "two words", RecentSearches: ["two words"], Messages: rows },
  ];
  for (const extra of dots) {
    const dot = pageDot(admin, "search", extra);
    for (const name of names) {
      const builder = F.fast[name];
      // Without the fast builders, fragment() renders every search macro
      // with nunjucks.
      const saved = names.map((n) => [n, F.fast[n]]);
      for (const n of names) delete F.fast[n];
      let want;
      try {
        want = R.fragment(name, dot);
      } finally {
        for (const [n, f] of saved) F.fast[n] = f;
      }
      assert.equal(builder(dot), want, name);
    }
  }
});
