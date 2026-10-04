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
| Jobs and bots | Actual queued HTTP delivery and persisted bot reply with FTS and recursive-webhook suppression; expired lease recovery, fencing, heartbeat renewal, bounded retries and dead state. |
| Backup/restore | Actual SQLite/storage round trip with integrity check; archive traversal/link rejection. Stop writers for consistency with file lifecycle. |

Verification is limited to the exercised workflows, not a claim of exhaustive Rails
parity. Public-site OpenGraph behavior and live browser-vendor push delivery remain
unverified; native transports reject private destinations and pin resolved addresses.
Malformed/legacy rich text outside the independent corpus can differ. Unsupported
older SQLite schemas require migration by the original application before upgrade.
