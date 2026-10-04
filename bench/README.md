# Benchmarks

Ruby orchestrates fresh production containers, alternating their order. The common
[load generator](https://github.com/basecamp/once-campfire-elixir/tree/main/bench)
is unchanged across implementations. Set `LOADGEN` to its compiled executable,
`BENCH_ENV_FILE` to the disposable fixture's environment, and `RUBY_IMAGE` and
`EXPRESS_IMAGE` to immutable production image IDs.

```sh
ruby bench/compare.rb --seed /path/to/parity/seed --concurrencies 16 \
  --routes room_show,messages_page,sidebar,search --duration 4
ruby bench/compare.rb --seed /path/to/parity/seed --concurrencies 16 \
  --routes post_message --duration 15
ruby bench/compare.rb --seed /path/to/parity/seed --suites cable \
  --cable-clients 100 --cable-tput-secs 0
```

The public Rust port's `parity/bin/seed build` creates the fixture. Server processes
share four hardware threads (`--cpus`); clients use separate threads (`--client-cpus`).
The runner verifies exact ordered HTTP result windows, successful persisted writes,
FTS entries, SQLite integrity and complete WebSocket delivery. It replaces fixture
push and webhook destinations with loopback test endpoints. Raw output stays in
ignored `tmp/bench/`; no benchmark results are tracked.
