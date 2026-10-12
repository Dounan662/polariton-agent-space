# Mixed MCP fixtures

These synthetic HTTP, stdio, and managed capabilities exercise mixed environment
preparation, discovery, partial failure, and worker access. They do not certify a
third-party desktop application or provider.

The HTTP and stdio fixtures compute `value * 7 + version`, returning text,
structured output, and an independent UUID receipt. The managed measurement fixture
uses the worker-assignment fixture's protocol. Receipt files omit credentials.

The default `npm test` suite covers provider-free real-Harness discovery and
process-ownership contracts. Container and live-provider checks are separate opt-ins
and require disposable infrastructure and an agreed scope. Keep generated traces
and budget ledgers private; never reset a ledger to obtain extra spending allowance.
See [development](../../../docs/DEVELOPMENT.md) for the contributor workflow.
