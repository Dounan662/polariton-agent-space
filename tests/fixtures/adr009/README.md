# Container MCP fixture

`server.mjs` uses the production `environment/server.mjs` authentication and session
boundary. Version 1 provides `statistics`; version 2 additionally provides
`weighted_statistics`. Both expose `stats://capability`, `echo`, and a deliberate
tool error. `POLARITON_FIXTURE_VERSION=1|2` selects the fixture version.

Statistics use population standard deviation (ddof=0). Arrays contain 1–10,000
finite numbers. Weighted arrays must have equal lengths, nonnegative finite
weights, and a positive finite total. A singleton has standard deviation zero;
empty arrays and invalid weights fail. Numeric overflow produces a tool error.
Qualification compares answers using absolute tolerance 1e-12 plus relative
tolerance 1e-10. These deterministic checks do not establish live-provider behavior.

Set `POLARITON_FIXTURE_CONTROL_TOKEN` to enable verifier-only endpoints. Pass it as
`Authorization: Bearer TOKEN`; it is distinct from MCP binding credentials.
`GET /evidence` reports completed calls and current barriers. `POST /control` accepts:

- `{ "action": "release", "barrier": "pair" }`: release all waiting calls with
  that barrier; wait for two `/evidence` entries before release to prove overlap.
- `{ "action": "resource", "mode": "normal|error|malformed|malformed-envelope|oversized", "delayMs": 0,
  "bytes": 0 }`: change future capability resource responses, including bounded
  slow and oversized replies. `malformed` means invalid JSON in declared JSON
  content; `malformed-envelope` violates the MCP resource response schema itself.
- `{ "action": "crash" }`: acknowledge then exit with status 71.
- `{ "action": "exhaust", "mode": "cpu|memory|output|disk|helpers" }`: start a helper
  workload. This requires both `POLARITON_FIXTURE_DESTRUCTIVE=1` and `/.dockerenv` and is
  intended exclusively for containers with enforced backend limits. Disk writes
  target `/state`. Do not run exhaustion workloads on the host.

Control responses do not certify containment. Qualification must independently
observe backend limits, child cleanup, bounded stored output, and continued calls
to a second mount. No fault controls are exposed in tool discovery. Runtime
credentials and fixture control tokens must not be copied into retained evidence.

Container qualification can instead call `fixture_fault` through an ordinary
authorized MCP connection. That tool exists only when destructive fixture mode is
explicitly enabled inside a container. Read-only `fixture://receipts` and
`fixture://limits` resources supply independent call, child-exit, and cgroup
evidence. The memory helper raises its own OOM score so the controlled allocating
helper is selected without depending on an accidental victim. Output receipts
count produced bytes; qualification separately measures the retained Docker log.
The same explicit fixture mode exposes `fixture_observation` to choose subsequent
resource faults through MCP. Rack tests use it to verify bounded observation,
stale cache provenance, recovery, and the absence of action calls during inspection.

`docker-barrier.mjs` is a host-side qualification helper, never installed in a
capability. The rack test prepends its generated wrapper directory only to one
daemon child's PATH. It forwards real Docker commands and temporarily holds the
inspect response for one named running mount, allowing SIGKILL before the
container receipt persists. A bounded release file ends the barrier. Restart
must adopt the same labeled runtime without duplicates or capability-call replay.
