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
sets the HTTP process count; publications pass through the primary process to every
worker. A separate leased SQLite queue handles jobs. TLS terminates at a proxy;
configure `TRUSTED_PROXIES` with its addresses.

For local development, use the pinned Node version, run `npm ci`,
`npm run build:assets`, set `SECRET_KEY_BASE`, then `npm start`. Run `npm test` for
native integration and independent Rails golden-vector tests. The public Rails
reference is immutable and pinned at `659f957`.

See [verification](plans/contracts.md) for tested workflows and remaining limits,
and [benchmark commands](bench/README.md) for the production comparison.

## Known differences

- TLS terminates at a configured proxy.
- Attached downloads and inline attachments recheck room membership; new draft uploads
  belong to their uploader. Legacy unattached signed drafts remain usable after sign-in.
- Native media variants use a separate digest namespace, preserving original files and
  rebuilding previews as needed. Native-library media bytes can differ.
- HTML whitespace and malformed-fragment repair can differ. Full byte parity is not claimed.
- Direct-room autocomplete explicitly requests JSON, repairing the original fetch-header bug.
- Backups require a maintenance window for consistent database and file snapshots. App and
  queue snapshots are separate; external job effects have at-least-once delivery.

MIT. Templates, asset compilation and compatibility contracts draw on the public Rails
application and existing Campfire ports; vendored frontend assets retain their licenses.
