# Contributor and coding-agent instructions

Read [architecture](docs/ARCHITECTURE.md), [development](docs/DEVELOPMENT.md), and
[contributing](CONTRIBUTING.md) before changing behavior. Keep this repository
self-contained: no imports, symlinks, or build inputs from private sibling projects.

## Design boundaries

- Main owns research records and worker control; Environment owns capability
  preparation and grants. DeepSeek Harness owns execution, context, and session history.
- Use public Harness adapters and presentation entry points. Do not add a second
  provider loop, history writer, or independent parser of upstream storage.
- Keep node, worker, session, process, and artifact identities distinct. Workers
  can share node files while maintaining separate context and permissions.
- Graph relationships describe research rather than imposing scheduling or coordination.
- Reading history must not activate an agent. Sending a message must not install
  environment infrastructure. Assignments retain exact capability revisions.
- Checkpoints use ordinary shared Git staging/history and exact retained references.
  Publication consumes staging and may include unfinished shared edits. Coordinate
  publishers and managed uploads per node without blocking worker admission; never
  claim exclusive authorship, recreate private capture, or infer per-file attribution.
- Environment owns preparation and account connections; Harness owns session processes
  and direct MCP calls. Keep preparation, discovery and functional validation distinct.
  Sending/resuming work never installs, applies or starts managed infrastructure.

## Implementation quality

Prefer deep modules with narrow typed interfaces and clear state ownership.
Consider alternatives before introducing abstractions. Explain purpose, invariants,
and failure boundaries in comments rather than repeating the code. Hide storage
and protocol details behind their owning module.

Fix root causes, remove replaced paths, and update callers. Keep limits in typed
configuration or budgets. Failures must be observable, bounded, and recoverable;
never turn uncertain execution into a successful receipt or silently replay a task.

Never delete retained data to bypass incompatibility. Preserve current-version
restart and recovery; document any changed data contract and its limits. Keep
credentials, research, and machine-local records outside public source.

## Verification and documentation

Test public behavior, ownership, idempotency, cancellation, and failure recovery.
Use deterministic fixtures and fakes at real module boundaries; avoid tests that
freeze private helper structure. Tests must use disposable storage.

Run `npm run check:public`, build, and relevant tests for code changes. Review links
and content for documentation-only edits. If packaging inputs change, check that
an extracted archive is complete and passes its integrity inspection. Do not run
billable or destructive opt-in campaigns without an agreed scope.

Update the appropriate public guide alongside behavior. Preserve licenses and
per-file provenance for adapted code. Keep implementation diaries, private campaign
output, and personal workflows out of `docs/`. See [maintenance](docs/MAINTAINING.md).
