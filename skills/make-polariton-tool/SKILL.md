---
name: make-polariton-tool
description: Register existing MCP servers, prepare npm/Python MCP packages, build managed MCP capabilities, and publish or apply Polariton environments through its public CLI. Includes the contracts and authoring template needed without reading Polariton source.
---

# Make a Polariton tool

Deliver the requested tool or environment using this skill's public contracts. This
folder contains the registration formats, mutation schemas, lifecycle guidance and
managed-server starter. Do not inspect Polariton's implementation, internal databases,
harness configuration or private access records to accomplish tool authoring. A
missing public capability is a limitation to report, not a reason to reverse-engineer
private state. The skill does not grant additional host, account or Docker authority.

## Choose the smallest supported path

- Existing HTTP endpoint, installed foreground program, or published npm/Python MCP
  package: use [MCP registration](references/mcp.md). Normally this is one configuration,
  preview (plus executable confirmation if needed), and one atomic import. Do not
  clone repositories or create workspace-local MCP installations for this path.
- Publish, update, apply or diagnose an environment: use
  [Environment operations](references/environment.md). Reuse existing capabilities
  and retained releases from inventory; publish the complete intended document.
- A new domain operation requires source you own: use
  [Managed authoring](references/managed.md) and copy the bundled
  [managed starter](assets/managed/). It includes its authorization helper, manifest,
  dependency lock and working MCP contract test. Author in a package directory inside
  the current workspace's Git repository, such as `capabilities/my-tool/`.

Read only the reference needed for the chosen path. More than one path may apply.
Do not create a new managed repository merely to wrap an existing MCP package or URL.

## Public command entry

Node 24.11.0 or newer and the required running daemons are prerequisites. Main-managed
workers receive `harnessctl` on PATH and authenticated installation context. For an
external caller, invoke the installed `bin/harnessctl` and supply `--config` pointing
to the installation's **app configuration**, which identifies both peer daemons.
Explicit configuration overrides `HARNESSCTL_CONFIG`; cwd never chooses a worker.

```sh
harnessctl help tools
harnessctl capability list
harnessctl environment list
```

Command-specific `--help` supplies required arguments, constraints and an example.
Use `--help --details` for operating guidance, or explicitly request the exact input
and output schemas with `--help --schema --json`. `--json` selects representation
without adding detail. Domain command stdout contains JSON including errors;
diagnostics use stderr. Successful query data is under `data`; mutations
return an owner receipt under `data`, whose `result` contains the domain outcome.
Generate and retain a UUID **before** each mutation and pass `--request-id UUID`.
Use `--input FILE|-` for structured JSON. After a lost reply, inspect the owner
operation reference or repeat the identical command with the retained request ID.
Do not create a new identity to evade an uncertain outcome. Partial preparation
and failed operations return nonzero status with their retained receipts.

Do not inspect private state, switch installations, or start another daemon to get
around an error. Direct CLI credentials authenticate the initiating worker; sender
arguments and environment identity hints cannot impersonate another worker.

## Complete the requested work

Keep installation, local preparation, live MCP discovery and application readiness
separate in the result. EnvironmentDaemon owns preparation: managed release installation
and explicit Apply can start the configured dedicated container runtime, fetch dependencies
and start managed containers. Workers do not run Docker or Colima commands, create host
directories outside their workspace, or request broader permissions to repair the runtime.
Report a retained preparation error when operator provisioning is required. Send does
not prepare infrastructure. DSH owns MCP connections and execution; Main owns worker
assignment. An unavailable MCP component is reported independently so the worker can
continue with healthy tools and ordinary conversation; never claim the missing tool
ran or that a dependent scientific task succeeded.

Return capability/revision IDs, environment/revision IDs, per-component preparation
outcomes, tested results and actionable remaining prerequisites. Worker assignment
remains the user's composer action; do not create or assign a consumer worker as an
installation step. Existing workers retain their assigned revision. Verify only
resources within the user's requested scope; paid provider tests require an existing
approved allowance. Successful package preparation does not certify a named desktop
application, start its bridge, or isolate its global state.
