# once-campfire-express

ONCE Campfire implemented natively with Node.js 24 and Express 5. The existing SQLite
schema, uploaded files, bcrypt passwords and Rails login cookies remain compatible.
Nunjucks renders the retained Turbo/Stimulus/Lexxy frontend; native WebSockets speak
Action Cable. No other Campfire implementation runs in the application process.

```sh
git submodule update --init
docker build -t once-campfire-express .
docker run --rm -p 8080:80 -e SECRET_KEY_BASE="$(openssl rand -hex 64)" \
  -v campfire:/rails/storage once-campfire-express
```

Existing installs must reuse their `SECRET_KEY_BASE` and mount their storage at
`/rails/storage`. Preserve VAPID keys for existing push subscriptions. `WEB_WORKERS`
sets the HTTP process count (default: available CPUs); publications pass through the
primary process to workers that hold WebSocket connections, and the primary is the
only writer for new messages without attachments (group commit). A separate leased SQLite queue handles jobs. TLS terminates at a proxy;
configure `TRUSTED_PROXIES` with its addresses.

For local development, use the pinned Node version, run `npm ci`,
`npm run build:assets`, set `SECRET_KEY_BASE`, then `npm start`. Run `npm test` for
native integration and independent Rails golden-vector tests. The public Rails
reference is immutable and pinned at `659f957`.

See [verification](plans/contracts.md) for tested workflows and remaining limits,
and [benchmark commands](bench/README.md) for the production comparison.

## Benchmarks

Measured with 16 concurrent clients on an AMD Ryzen AI MAX+ 395,
with four hardware threads allocated to each app.

| HTTP workload (requests/sec) | Rails | [Django](https://github.com/basecamp/once-campfire-django) | [Laravel](https://github.com/basecamp/once-campfire-laravel) | [Express](https://github.com/basecamp/once-campfire-express) | [Elixir](https://github.com/basecamp/once-campfire-elixir) | [Go](https://github.com/basecamp/once-campfire-go) | [Rust](https://github.com/basecamp/once-campfire-rust) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Room page | 241 | 170 | 164 | 559 | 722 | 3,860 | 36,260 |
| Messages page | 413 | 196 | 175 | 777 | 1,053 | 5,573 | 40,872 |
| Sidebar | 552 | 615 | 715 | 4,125 | 1,275 | 19,753 | 34,672 |
| Search | 435 | 315 | 305 | 1,294 | 1,156 | 7,053 | 33,299 |
| Post a message | 273 | 154 | 137 | 256 | 801 | 4,767 | 6,896 |

At 100 WebSocket connections and five messages/second, median delivery to every
connection was 24 ms for Rails and 14 ms for Express. Every message reached every
connection in both runs.

## Known differences

- TLS terminates at a configured proxy.
- Attached downloads and inline attachments recheck room membership; new draft uploads
  belong to their uploader. Legacy unattached signed drafts remain usable after sign-in.
- Native media variants use a separate digest namespace, preserving original files and
  rebuilding previews as needed. Native-library media bytes can differ.
- HTML whitespace and malformed-fragment repair can differ. Full byte parity is not claimed.
- Direct-room autocomplete explicitly requests JSON, repairing the original fetch-header bug.
- A session cookie re-sent for the same old cookie and same new session within one second is
  reused, so its embedded expiry can be up to one second older than the response time.
- A byte-identical repeat of a hot GET (same URL, client address and raw headers) answered by
  the raw repeat path reuses the body built earlier in the same clock second, so its CSRF
  mask (and the ETag) is the same for every such repeat in that second. Rails masks the token
  again on every request. The masked token is still valid for that session; only the
  per-request BREACH re-masking is weaker within that second.
- Workers accept connections with a plain `net.Server` (set `NET_FRONT=0` to use node:http
  directly). It answers raw repeat hits itself with the same bytes node:http would send,
  serves other plain keep-alive GETs through the same request handler with node's own
  request/response objects, and hands every other connection (POST, upgrade, HTTP/1.0,
  `Connection: close`, unusual header syntax) to node:http for good. Before that
  hand-off, node:http's header and request timeouts do not apply; an idle socket still
  closes after the keep-alive timeout.
  Front hits read the database change marker at most once per event-loop turn. A GET
  that is pipelined behind an unanswered request on the same connection can, in rare
  timing, get the page from just before another process's write; a client that waits
  for each response (browsers, the benchmark) always sees the write.
- The sidebar keeps each user's room list HTML until the next database write by any
  process. Without the page cache (not-crazy-perf), its gzip answer sends the per-request
  head and tail as stored (not compressed)
  deflate blocks, so the compressed size and the `ETag` differ; the decoded HTML is the same.
- The answer to posting a message (`POST /rooms/:id/messages`) is sent without gzip, also
  when the client accepts gzip (identity is always an acceptable coding). Rails gzips it.
  The body and all other headers are the same; gzip of the ~8 KB turbo stream cost more
  server CPU than it saved.
- Backups require a maintenance window for consistent database and file snapshots. App and
  queue snapshots are separate; external job effects have at-least-once delivery.

MIT. Templates, asset compilation and compatibility contracts draw on the public Rails
application and existing Campfire ports; vendored frontend assets retain their licenses.
