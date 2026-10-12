# Capabilities and environments

A **capability** describes a tool source. An **environment** selects capability
revisions and configuration for a worker. Ordinary conversation and built-in
Harness tools work without a managed container environment.

## Supported tool sources

| Source | What you provide | Preparation |
| --- | --- | --- |
| HTTP MCP server | Endpoint and any required credential references | Validate configuration; Harness connects when the worker starts |
| Stdio MCP server | Installed foreground executable or supported package recipe | Resolve prerequisites and prepare packages during Apply |
| Managed capability | Git repository with a capability manifest | Build a pinned commit and run it with container limits |

Review a tool's code, permissions, network access, and credentials before using
it. Host programs run with the user's access; a managed container and a host
program have different security boundaries. See [security](../SECURITY.md).

## Add and use capabilities

1. Open **Env → Capabilities → Add**. Choose **From repository** or **From MCP configuration**.
2. Preview the configuration and resolve validation errors or executable choices.
   Registration records the definition; it does not run or install the tool.
3. Create an environment and select the desired capability revisions. Managed
   capabilities need an installed release before they can be selected. Adding or
   editing components publishes the new environment revision.
4. Choose **Apply** to prepare that revision. Inspect each component's outcome;
   partial readiness can leave some tools unavailable.
5. Select the prepared environment before a worker's first message.

Sending a task does not install or start container infrastructure. HTTP and stdio
preparation does not require Docker. A prepared external component is ready for
Harness to attempt connection; preparation alone does not prove the server works.

Assignments retain exact revisions. Changing a definition does not silently update
existing workers. For a failed connection to the same retained definition, correct
the prerequisite or server, then close and resume the worker. Do not replay a task
until you understand its previous outcome.

## MCP configuration

A simple existing endpoint can be previewed with:

```json
{
  "mcpServers": {
    "analysis": {
      "type": "http",
      "url": "https://example.invalid/mcp"
    }
  }
}
```

Replace the example URL with your server's endpoint. Do not put credentials in
public examples. For executable resolution, secret references, package recipes,
and exact import formats, use the maintained [MCP registration reference](../skills/make-polariton-tool/references/mcp.md).
The [environment reference](../skills/make-polariton-tool/references/environment.md)
describes publication, Apply, and recovery. These references are also used by
Polariton's tool-authoring skill.

## Managed containers

On macOS, managed capabilities use the dedicated Colima profile `polariton`.
With Homebrew available, provision it before using managed capabilities:

```sh
brew install colima docker
colima start polariton --cpu 4 --memory 8 --disk 30 --runtime docker --vm-type vz
```

The default socket is `~/.colima/polariton/docker.sock`. On Ubuntu, provision a
local Docker Engine separately and deliberately grant your account access to
`/var/run/docker.sock`. Rootless and remote Docker engines are outside the tested
profile. Polariton does not install Docker or switch your global Docker context.

Managed builds use immutable source and image identities. Limits and persistent
volumes belong to the capability and its environment; back up persistent volumes
separately from Polariton's data. For new tools, use the
[managed authoring reference](../skills/make-polariton-tool/references/managed.md)
and [starter](../skills/make-polariton-tool/assets/managed/).

## Inspect and troubleshoot

Use the environment view to inspect preparation and component failures. Missing
credentials, executables, prerequisites, or container resources should be corrected
before another Apply. Connection failures can leave healthy tools usable; inspect
the worker's per-component startup status rather than assuming all tools loaded.

The bundled official catalog is currently empty. You can register your own
capabilities. The [CLI](CLI.md) provides capability, environment, and catalog
inspection without directly editing internal databases.
