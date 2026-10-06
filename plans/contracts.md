# Compatibility and verification

Native JavaScript/Express implementation; immutable public Rails reference `659f957`.
Existing SQLite schema, original files, bcrypt credentials and Rails JSON cookies are
the compatibility contract. Raw evidence stays ignored in `tmp/`.

| Area | Evidence |
|---|---|
| Rails signing, encryption and CSRF | Independent Rails vectors verify PBKDF2 keys, signed/encrypted cookies, signed IDs including large integers, SGIDs, application verifiers, Turbo streams, session continuity, purpose/expiry/signature rejection and 189 CSRF cases. Bounded data-only Marshal fixtures come from Ruby. |
| SQLite and messages | Real isolated databases test nested rollback, membership authorization, raw timestamp cursors, persisted writes, updates/deletion and FTS; independent HTTP checks compare actual stored records. |
| Frontend | Independent browser checks cover live compose/edit/delete/boost, mentions, paging, search, private/direct rooms, image upload/lightbox, administration and fresh setup. |
| Sessions | Independent original Rails server accepts Express-issued cookies and Express accepts Rails-issued cookies on shared disposable data. An identical session update from the same incoming cookie reuses the value encrypted under one second earlier (embedded expiry lags by under one second). |
| Action Cable | Real sockets verify native subscription delivery, forged stream rejection, membership revocation, logout revocation and multi-tab presence. Cross-worker production browser delivery is exercised. |
| Storage and media | Actual 3840×2160 JPEG becomes 1200×675; real ffmpeg audio/video analysis and poppler PDF preview; Rails-issued signed transform accepted; direct upload checksum/range/owner/private-room checks and failed-media rollback. |
| Benchmarks | Matched production images with identical ordered 40-room/40-page/13-search windows, zero timed request failures, every acknowledged write stored with rich text and FTS, and SQLite integrity checks. Two paced runs admit all 100 sockets and deliver all 30 messages to every connection. Raw output remains ignored. |
| Jobs and bots | Actual queued HTTP delivery and persisted bot reply with FTS and recursive-webhook suppression; expired lease recovery, fencing, heartbeat renewal, bounded retries and dead state. |
| Backup/restore | Actual SQLite/storage round trip with integrity check; archive traversal/link rejection. Stop writers for consistency with file lifecycle. |

Verification is limited to the exercised workflows, not a claim of exhaustive Rails
parity. Public-site OpenGraph behavior and live browser-vendor push delivery remain
unverified; native transports reject private destinations and pin resolved addresses.
Malformed/legacy rich text outside the independent corpus can differ. Unsupported
older SQLite schemas require migration by the original application before upgrade.

The frozen production runtime is `124694f` (Node 24.21.0 / Express 5.2.1). All 52
native methods pass without seed skips. Independent checks passed 26 browser
assertions without JavaScript errors, 18 HTTP/session checks, 11 request boundaries,
6 crafted room-namespace checks, 4 real multi-tab presence checks and 3 socket
privacy checks. Runtime source and compiled asset hashes match the production image.

HTTP reads use two 4-second samples; writes use two 15-second samples, alternating
implementation order. Express posting varied from 206 to 305 requests/second, with
higher tail latency than Rails; the table reports the median, not a capacity limit.
The unchanged common load generator and original seed hashes are recorded in ignored
scratch evidence. Benchmark orchestration is Ruby, and server processes share four
hardware threads; Express uses three HTTP workers and its primary job/fanout process.

## Page and message HTML caches

Room, messages-page, sidebar, search and single-message pages are cached per
process (`src/rendering.js`): one entry per message (key: message id + origin,
checked against the presentation row) and one entry per page (key: route
inputs, full user row, host, protocol, Turbo-Frame, session last room). All
entries are dropped when `epoch()` in `src/db.js` moves, which happens on any
commit from any process. The decoded HTML is byte-identical to an uncached
render except for the random CSRF token. Deliberate differences: gzip bytes
are made by the app (one stored gzip for pages without a token; for pages with
a token, a prebuilt stream whose token bytes are patched per request), so the
compressed bytes and the `ETag` values differ from what the compression
middleware and Express would make; brotli, deflate, identity and HEAD still
go through the normal middleware. Verified by decoding with Node zlib, Ruby
`Zlib::GzipReader` and `curl --compressed` against the uncached code on a
seeded database before and after boosts, edits, renames and posts.

Raw repeat path (`fastPath` in `src/app.js`): when a hot GET (room, messages
page, sidebar, search) is answered from the page cache through the normal
path, the app records the response headers and the derived request state. A
later GET with the same URL, client address and byte-identical raw header
list is answered with one `writeHead` + `end`, without Express, while all of
these still hold: same `epoch()`, same page cache entry, session activity
newer than one hour (no `last_active_at` write due), cookie expiries in the
future, unchanged secret, and, when a session cookie is set (room pages set
`last_room_id`), the memoized encrypted cookie is still valid (under one
second old, the same 1 s staleness the normal path allows). The CSRF mask,
`ETag`, `Content-Length` and cookie `Expires` are made fresh once per entry
per clock second: repeats in the same second reuse the built body and header
list (deliberate difference: Rails re-masks per request; the reused masked
token still unmasks to the session's CSRF secret).
New sessions, bot keys, conditional requests, non-gzip token pages and any
other case use the normal path. `test/raw_fast.test.js` compares status,
header order and values (except `Date`, the CSRF-dependent `ETag` part and
the `Expires` second) and decoded bodies of both paths.

Net front (`src/netfront.js`, on unless `NET_FRONT=0`): the worker listens
with a plain `net.Server`. Each new connection starts there. A complete
`GET ... HTTP/1.1` head with plain `Name: value` header lines (no body
headers, no `Upgrade`, no `Expect`, `Connection` only as `keep-alive`) is
looked up with the same raw repeat match and the same validity checks; a hit
is written as one Buffer that is byte-identical to what node:http writes for
the raw repeat path (headers, then `Date`, `Connection: keep-alive`,
`Keep-Alive: timeout=N`, then body). Several hits pipelined in one TCP read
share one `epoch()` read (same synchronous run, nothing else can commit in
between). On the first request that is not such a hit, the unread bytes are
put back on the socket and the socket is handed to the node:http server for
the rest of its life (so the miss still records an entry, and WebSocket
upgrades, POSTs, HTTP/1.0 and `Connection: close` behave as before). Limits:
idle front sockets close after `keepAliveTimeout`, but node:http's
`headersTimeout`/`requestTimeout` only apply after hand-off; a partial head
larger than 16 KiB is handed off. `test/net_front.test.js` checks hits,
byte equality with node:http in the same second, keep-alive, split and
pipelined heads, miss hand-off, `Connection: close`, HTTP/1.0, POST and the
cable WebSocket. The parity harness runs with a frozen clock, so there it
only exercises the hand-off path.

`epoch()` first reads the 96-byte WAL-index header at the start of the
`-shm` file. Every commit by any connection (this one included) and every WAL
restart rewrites that header (change counter, frame count, salts, checksums;
copy 1 is written before copy 0). If both copies are equal and identical to
the header read before the last SQL check, no commit can have happened since,
and the SQL (`data_version`, `total_changes()`) is skipped. Otherwise, or in a
non-WAL database or with `EPOCH_SHM=0`, the SQL runs as before.
`test/epoch_shm.test.js` checks that commits from both connections and WAL
restarts move the epoch. Limit: this relies on SQLite's documented WAL-index
layout and on `read()` of the `-shm` file seeing the shared mapping (true on
Linux and macOS, which share one page cache for both).
