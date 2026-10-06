# Compatibility and verification

Native JavaScript/Express implementation; immutable public Rails reference `659f957`.
Existing SQLite schema, original files, bcrypt credentials and Rails JSON cookies are
the compatibility contract. Raw evidence stays ignored in `tmp/`.

| Area | Evidence |
|---|---|
| Rails signing, encryption and CSRF | Independent Rails vectors verify PBKDF2 keys, signed/encrypted cookies, signed IDs including large integers, SGIDs, application verifiers, Turbo streams, session continuity, purpose/expiry/signature rejection and 189 CSRF cases. Bounded data-only Marshal fixtures come from Ruby. |
| SQLite and messages | Real isolated databases test nested rollback, membership authorization, raw timestamp cursors, persisted writes, updates/deletion and FTS; independent HTTP checks compare actual stored records. |
| Frontend | Independent browser checks cover live compose/edit/delete/boost, mentions, paging, search, private/direct rooms, image upload/lightbox, administration and fresh setup. |
| Sessions | Independent original Rails server accepts Express-issued cookies and Express accepts Rails-issued cookies on shared disposable data. Every changed session is encrypted again for each response. |
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

## Message HTML cache (branch `not-crazy-perf`)

This branch keeps the normal speed work and drops response reuse: there is no
whole-page cache, no raw repeat path and no `net.Server` front. Every page is
rendered for each request, with a freshly masked CSRF token, and every changed
session cookie is encrypted for each response, as in Rails.

Rendered message HTML is cached per process (`src/rendering.js`): one entry
per message (key: message id + origin, checked against the presentation row).
All entries are dropped when `epoch()` in `src/db.js` moves, which happens on
any commit from any process. The decoded HTML is byte-identical to an uncached
render except for the random CSRF token. Each cached message is kept as pieces
split at its forms, and each piece keeps its raw-deflate stream (ended with
`Z_SYNC_FLUSH`). For a gzip page the app deflates the layout pieces at level 1,
writes the CSRF token as stored blocks and joins everything with the message
pieces, one final empty block and the CRC/length trailer. Deliberate
difference: these gzip bytes and the `ETag` values differ from what the
compression middleware and Express would make (pages with a token get an ETag
from a per-request page id and the token, because the body differs on every
request anyway); brotli, deflate, identity and HEAD still go through the
normal middleware. Verified by decoding with Node zlib and by the parity
harness.

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

The answer is gzipped like every other response (as Rails does). Also on this path: Express'
weak ETag is made with one `crypto.hash` call (same value as the `etag`
package; the `etag` setting stays `weak`), `publishMessage` returns before it
builds anything when `publish()` would drop it (no WebSocket in any worker),
the push endpoint check is memoized per endpoint string, and `notifyMessage`
runs the push-subscriptions query only when some member passes the
involvement and connection checks. With several workers the primary also
reads each room's members (user id, involvement, connected_at, role, status)
and its push-permitted users once per batch, inside the write transaction (its
page cache is warm), and sends them with every reply; the worker uses them for
the unread broadcasts and push/webhook jobs instead of two reads on a page
cache the commit just made cold. They show the rows as of the post's commit
(the worker read them a moment after it). If that read fails, the worker reads
them itself. Checked: same push jobs per post with 1 and 3 workers and with
the previous build (permitted endpoints, 3 jobs per post), npm test, parity. Tried and dropped: one IPC message per tick
for posts and per batch for replies (no CPU change, lower throughput); 2, 3 and
6 workers instead of 4 (all slower on the 3-CPU post bench).
