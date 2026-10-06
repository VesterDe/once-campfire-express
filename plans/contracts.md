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
between). A front-eligible GET that is not a hit is served on the same
socket: the front builds node's own `IncomingMessage` (method, URL, raw
headers, HTTP/1.1, no body) and `ServerResponse` (keep-alive, server
keep-alive timeout), emits the http server's `request` event, and reads the
socket again after `finish` (so the miss records an entry and later repeats
on that socket are front hits). Any other request (other method, body
headers, `Upgrade`, HTTP/1.0, `Connection: close`, header syntax the front
does not parse exactly like llhttp) puts the unread bytes back and hands the
socket to the node:http server for the rest of its life, so WebSocket
upgrades and POSTs (including `src/fast_post.js`) run unchanged. Limits:
idle front sockets close after `keepAliveTimeout`, but node:http's
`headersTimeout`/`requestTimeout` only apply after hand-off; a partial head
larger than 16 KiB is handed off; while a front miss is in flight, later
pipelined bytes wait and are not parsed. `test/net_front.test.js` checks hits,
byte equality with node:http in the same second, keep-alive, split and
pipelined heads, misses served in place (same header names as node:http, no
listener leak), hand-off, `Connection: close`, HTTP/1.0, POST and the
cable WebSocket. The parity harness runs with a frozen clock (no hits), so there
it exercises the in-place miss and hand-off paths.

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

## Posting a message (group commit, single writer)

`POST /rooms/:id/messages` without an attachment goes through
`src/post_writer.js`. Posts that arrive while a write is under way share one
transaction. The batch first runs with no savepoint at all (inside a
savepoint SQLite copies each changed page to a sub-journal file first). If any
statement throws, the whole batch rolls back and runs again with one savepoint
per post, so only the failing posts get an error. The room `updated_at` and the
memberships unread `UPDATE` run once per room / (room, creator) at the end of
the batch, in post order. This gives the same rows as running them once per
post: a later post of the same creator writes a later time to a superset of the
rows (its 60 s connection cutoff is later). Every response is sent after the
shared `COMMIT`.

With `WEB_WORKERS` > 1 the HTTP worker sanitizes the body, computes its search
text and sends the post over IPC to the primary process, which is the only
writer for posts (one connection, warm cache, no lock hand-offs, larger
batches). The primary returns the inserted row; the worker renders, answers and
then broadcasts and enqueues push/webhook jobs in the same tick. HTTP workers
do not checkpoint; the primary uses SQLite's automatic checkpoint with a
10000-page (about 40 MB) WAL threshold. Before this, timer checkpoints never
caught up with a busy writer and the WAL grew without bound (about 55 MB/s
under the post benchmark).

`src/fast_post.js` routes these POSTs through the app's own router stack minus
layers whose path cannot match `/rooms/<digits>/messages` and minus the JSON
and text body parsers (urlencoded bodies only). Headers, encoding, urlencoded
parser, method override, session, bans/CSRF, the route, 404 and error handler
run unchanged. Verified: response headers and bodies equal to the full router
(identity and gzip), the parity harness (only the known Content-Length vs
chunked and `/users/2` log text differences), persisted rows equal to the
reference build except push jobs for non-permitted endpoints, `integrity_check`
ok and an FTS row for every 200 under load. Limit: a crash of the primary
between `COMMIT` and the IPC reply loses that reply (the post is stored).

Deliberate difference: every response on `POST /rooms/<digits>/messages` is
sent without gzip when gzip is the negotiated coding (br/deflate clients still
go through `compression()`). `Vary: Accept-Encoding`, the ETag of the plain
body and all other headers stay. Rails gzips this answer. Measured: about 14%
less server CPU per post and about +30% posts/s in the 3-CPU Docker bench
(4.7-4.9k -> 6.4-6.5k req/s, alternating runs). Also on this path: Express'
weak ETag is made with one `crypto.hash` call (same value as the `etag`
package; the `etag` setting stays `weak`), `publishMessage` returns before it
builds anything when `publish()` would drop it (no WebSocket in any worker),
the push endpoint check is memoized per endpoint string, and `notifyMessage`
runs the push-subscriptions query only when some member passes the
involvement and connection checks. Tried and dropped: one IPC message per tick
for posts and per batch for replies (no CPU change, lower throughput); 2, 3 and
6 workers instead of 4 (all slower on the 3-CPU post bench).
