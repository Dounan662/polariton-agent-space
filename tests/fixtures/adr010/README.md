# Worker-assignment fixtures

These synthetic MCP capabilities test assignment to retained environment revisions.
They are test inputs, not integrations intended for normal research.

Two instances expose separate `measure` and `transform` tools. Measurement uses a
seed-derived integer in container configuration. Transform revision 1 computes
`3 × value + 11`; revision 2 computes `7 × value + 19`. Invocation logs include
inputs, an independent UUID receipt, and outcome. Tests compare those receipts
with observed tool results.

`mode: error` returns a controlled error; `mode: slow` delays completion. Cancelling
an observation does not roll back remote execution, so tests must retain the actual
outcome. The SDK client is a development dependency for the fixture contract test;
containers install production dependencies.

Use disposable configurations, credentials, workspaces, and containers for host
integration work. Live-provider tests require a separate scope and spending budget;
normal contributions use the checks in [development](../../../docs/DEVELOPMENT.md).
