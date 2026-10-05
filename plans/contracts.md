# Compatibility and verification

Native JavaScript/Express implementation; immutable public Rails reference `659f957`.
Existing SQLite schema, original files, bcrypt credentials and Rails JSON cookies are
the compatibility contract. Raw evidence stays ignored in `tmp/`.

| Area | Evidence |
|---|---|
| Rails signing, encryption and CSRF | Independent Rails vectors verify PBKDF2 keys, signed/encrypted cookies, signed IDs including large integers, SGIDs, application verifiers, Turbo streams, session continuity, purpose/expiry/signature rejection and 189 CSRF cases. Bounded data-only Marshal fixtures come from Ruby. |
| SQLite and messages | Real isolated databases test nested rollback, membership authorization, raw timestamp cursors, persisted writes, updates/deletion and FTS; independent HTTP checks compare actual stored records. |
| Frontend | Independent browser checks cover live compose/edit/delete/boost, mentions, paging, search, private/direct rooms, image upload/lightbox, administration and fresh setup. |
| Sessions | Independent original Rails server accepts Express-issued cookies and Express accepts Rails-issued cookies on shared disposable data. |
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
