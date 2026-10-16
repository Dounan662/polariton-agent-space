---
name: make-polariton-tool
description: Build original MCP tools or prepare existing packages, bundles and endpoints through Polariton's public environment operations. Use for capability authoring, deployment, validation and preparation recovery.
---

# Make a Polariton tool

Deliver the requested capability through EnvironmentDaemon's public contracts. The
common path is **prepare, inspect, validate**. The daemon owns source resolution,
dependencies, exact artifacts and durable recovery; the worker supplies the intended
capability and resolves explicit choices. Do not inspect implementation source,
internal databases, private configuration or access records to author a tool.

## Choose a complete operation

For capability-only requests, use `harnessctl capability add` to retain the source,
then `capability complete` to finish setup on that capability. This never creates an
environment. A human can finish authentication in **Environment → Capabilities**.
See [Capability preparation](references/preparation.md) for the input contract.

When the task also requests a usable environment, the compound preparation operation
creates and prepares it from an MCP package, endpoint or full specification:

```sh
harnessctl environment prepare --name Browser --source npm:@playwright/mcp@0.0.83
```

This version illustrates syntax. Use the source and explicit version selected for
the requested task. The response supplies exact environment/revision IDs, accepted
defaults, separate evidence and any required next action. No normalized import JSON,
launcher path or manually composed environment is needed for the common path.

- For mixed capabilities, authentication, named functional checks or application
  assets, the same prepare operation accepts a complete specification with `--input`.
- For a new domain operation whose source you own, read
  [Managed authoring](references/managed.md) and use the [starter](assets/managed/).
  Write and test the domain code in the current workspace, commit its package
  directory, then use the reference's complete Git-source `environment prepare`
  specification. No registry publication or separate repository is required.
  Do not wrap a third-party package merely to fit a managed template.
- For deliberate definition-only registration or revision, use
  [MCP registration](references/mcp.md). For expert composition and managed lifecycle
  control, use [Environment operations](references/environment.md).

Read the reference needed for the chosen task. A registry format does not guarantee
that every runtime combination or prerequisite is supported. Report a retained
unsupported result; never substitute an unrelated shell installation as proof.

## Public command entry and recovery

Main-managed workers receive `harnessctl` on PATH and authenticated installation
context. External callers use the installed `bin/harnessctl` and an explicit
`--config` pointing to its app configuration. Node 24.11.0 or newer and running
peer daemons are prerequisites; cwd never chooses a worker or installation.

```sh
harnessctl help tools
harnessctl environment prepare --help
harnessctl environment inspect ENVIRONMENT_ID
harnessctl environment validate ENVIRONMENT_ID --revision REVISION_ID
```

Help is offline. Command help explains necessary inputs; `--help --details` expands
guidance and `--help --schema --json` exports the exact contract when needed.
`--json` changes representation, never detail. Domain stdout contains JSON under
`data`; mutation outcomes are under `data.result`. Keep stderr: prepare, validate,
continue and cancel generate a UUID and flush a recovery envelope before dispatch.
Omit `--request-id` for a new complete operation; no separate UUID-generation step is
needed. You may instead supply your own retained `--request-id UUID`. Other expert mutations
require one. The owner durably records effects; the CLI keeps no private journal.
Use compact command output first. If you save output, retain stdout and stderr
without truncation; pipelines such as `head` or `tail` can lose recovery identity and
hide the command's exit status.

After a lost response, inspect its owner-qualified operation reference. Retry only
with the identical request ID/input, or resolve a specific pending action through
`operation continue`. A new ID is a new request. Observer timeout does not cancel
work. Preserve failed, blocked, partial and uncertain outcomes; inspect `--details`
for retained attempts and provenance. Do not switch installations or start another
daemon to evade an error.

## Finish with evidence

Keep registration, dependencies ready, authentication, connection, discovered tools
and functional checks distinct. Default validation is inference-free connection and
discovery through Harness. `--check NAME` runs an explicitly declared functional
check with its stated effects; tool annotations are not a safety guarantee. A
Playwright test must actually navigate/interact through the prepared MCP connection.
A separately launched browser or a successful tools list is insufficient.

A worker may inspect readable locations and propose a dependency path through a
pending action. The daemon validates the candidate; do not alter global PATH, run
package installers or container commands to repair preparation, or read private
credentials. Account login and consent require the owner UI. Pending components
appear in **Environment → Capabilities** before login. Give the human the capability
name, component ID and retained operation reference; its full page owns account setup.
Completing a standalone capability never creates an environment. For a capability
in an existing environment preparation, continue that original plan explicitly after
its required setup is resolved. The UI creates environments by selecting existing
capabilities; sources and authentication belong to the capability page.
OAuth connections bind one protected resource: use separate connection IDs for
different endpoints, even for the same provider and human account. Read the account
workflow in [Capability preparation](references/preparation.md). Never ask for
client secrets or tokens in chat or write them into specifications. A raw endpoint
import neither retains the OAuth setup action nor makes the capability authenticated;
do not replace a blocked preparation with a bare import.

Return exact capability/environment revisions, tested outcomes and remaining actions.
Send and resume never prepare infrastructure. Healthy components and conversation
remain available when another component fails. Worker assignment is immutable after
activation. Create a separate consumer worker only when the task explicitly requests
one; installation and validation do not create or assign workers. Real-provider
consumer tests use the authorized bounded allowance and the exact prepared revision.
