# Capabilities and environments

A **capability** describes a source, runtime, connection, requirements and
authentication. An **environment** selects exact capability revisions and settings
for a worker. Ordinary conversation and built-in Harness tools need no managed
container environment. Sending or resuming work never installs infrastructure.

## Prepare and validate tools

Use the CLI's complete preparation operation for a package or endpoint:

```sh
npm run harnessctl -- environment prepare --name Browser --source 'npm:@playwright/mcp@0.0.83' --preview
npm run harnessctl -- environment prepare --name Browser --source 'npm:@playwright/mcp@0.0.83'
npm run harnessctl -- environment inspect ENVIRONMENT_ID --revision REVISION_ID
npm run harnessctl -- environment validate ENVIRONMENT_ID --revision REVISION_ID
```

Replace the IDs with the returned environment and revision. Preview does not
install, launch or reserve identities; unresolved remote selections remain explicit.
Preparation retains exact sources, publishes the environment revision and prepares
its dependencies. It can finish partial or blocked. Inspect each component.

Validation connects and discovers tools through Harness without creating a worker
or making a model call. `--check NAME` runs an explicitly declared functional check
with its declared effects and budget. Preparation is not connection evidence;
discovery is not a functional pass; a functional pass is not continuous health.
Select the prepared environment before the worker's first message. No preparation
or validation operation automatically assigns an environment or creates a worker.

| Source | Supported preparation contract |
| --- | --- |
| npm / PyPI | Exact packages with private reusable installations; npm hooks disabled, PyPI wheels only |
| NuGet / Cargo | Explicit package versions and required SDK/compiler; Cargo needs native-build authority |
| OCI image | Exact image selection; isolated prepared stdio instances, without network, host mounts, credential injection or persistent volumes |
| MCP bundle | Integrity-checked MCPB manifest 0.3 with direct Node/Python/native entrypoints |
| Git package | Exact committed subtree and declared build/test recipe |
| Existing installation | Explicit executable and declared prerequisites; host drift requires revalidation |
| HTTP MCP endpoint | External service reference; Polariton does not operate the remote service |

Convenience prefixes are `npm:`, `pypi:`, `nuget:`, `cargo:` and `oci:`; HTTP URLs
select external endpoints. Exact package versions are required. Bundles, installed
commands, Git packages and mixed environments use `--input specification.json`.
Use `environment prepare --help --schema` for the complete contract. Updating an
existing environment requires its target ID, expected revision and complete component
list; a stale revision conflicts rather than overwriting concurrent changes.

Review tool code, permissions, network access and credentials. Host programs and
native builds use the owner's access, not an OS sandbox. Unsupported recipes return
explicit blockers. See [security](../SECURITY.md) and [qualification](COMPATIBILITY.md).

## Recover a blocked operation

Preparation, continuation and validation generate request identities and print
recovery information before dispatch. Keep complete stdout/stderr. After a timeout,
inspect that operation instead of submitting a new installation:

```sh
npm run harnessctl -- operation get environment:REQUEST_ID --details
npm run harnessctl -- operation continue environment:REQUEST_ID --input resolution.json
npm run harnessctl -- operation cancel environment:REQUEST_ID
```

A resolution names the current `expectedVersion`, `actionId`, and the requested
retry, toolchain path or completed owner authentication. Read executable help for
the schema. Observation timeouts do not cancel work; cancellation must settle owned
processes and resources. Uncertain effects require inspection before retry.

## Capability pages and accounts

Open **Environment → Capabilities** and select a pending or registered capability.
Its full page owns account setup; an environment component's **Open capability**
link leads there too. Pending components remain visible before account setup or
environment publication and after reload.

Save private account settings and explicitly connect the account. Browser login
and consent require the owner's action; worker commands return a pending action.
Never put tokens in capability JSON, CLI arguments or public examples. An OAuth
connection is bound to one resource URL; different services need separate connection
IDs even when they share a provider client registration.

For a pending capability, **Save authentication setup** retains the reviewed account
choice and **Finish setup** completes the component after login. Completing a
component does not publish its parent environment or discard sibling components.
Open the retained parent plan and choose **Continue environment preparation** to
finish the full plan. A standalone capability draft prepares reusable dependencies
without creating an environment.

For a registered capability, **Save account binding** creates a new exact revision.
Select that revision explicitly when composing an environment. Existing environment
revisions and workers keep their previous references. Assignment, including
**No environment**, stays fixed after activation. Repairing preparation of the same
definition can be observed on fresh activation; changing a definition requires a
new selected revision and worker.

OAuth supports discovery, supported client registration, PKCE and scoped live
refresh. Provider compatibility is bounded, not universal. Google Workspace endpoint
forms select Google metadata and preregistered-client mode; enter client settings
privately using the displayed callback URI. Real Google consent and authenticated
Workspace calls still require owner setup and verification. Secrets use private
POSIX files, not an OS keychain. Local disconnect does not claim upstream revocation;
static credentials already copied into a process require worker restart.

## Expert registration and composition

Definition-only registration remains available. **Add** supports repository and MCP
configuration entry paths; preview and registration do not install or run a tool.
Compose exact capability revisions, then **Apply** the selected environment revision.
Managed authored capabilities require an installed release. Editing components
publishes a revision; it does not silently update existing assignments.

A simple existing endpoint configuration is:

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

Replace the URL with your server's endpoint. A URL without an authentication declaration
does not prove tool calls need no login. See the maintained
[preparation reference](../skills/make-polariton-tool/references/preparation.md),
[MCP import reference](../skills/make-polariton-tool/references/mcp.md), and
[environment reference](../skills/make-polariton-tool/references/environment.md).

## Managed containers

On macOS, provision the dedicated Colima profile `polariton` before container use:

```sh
brew install colima docker
colima start polariton --cpu 4 --memory 8 --disk 30 --runtime docker --vm-type vz
```

The default socket is `~/.colima/polariton/docker.sock`. Explicit preparation can
start an already provisioned configured profile and fill prepared capacity; access
only claims available capacity. Sending work never starts the engine. Polariton
does not install Docker, create the profile or switch the global Docker context.

On Ubuntu, provision a local Docker Engine and deliberately grant your account
access to `/var/run/docker.sock`. Rootless/remote engines and the new generic OCI
preparation path on Ubuntu are outside the qualified profile.

Managed builds retain source and image identities. Authored Git containers use a
separate server-grant boundary from generic OCI stdio instances. Back up persistent
capability storage separately; removing a definition or releasing access does not
silently delete its user data. For authored tools, use the
[managed reference](../skills/make-polariton-tool/references/managed.md) and
[starter](../skills/make-polariton-tool/assets/managed/).

## Inspect and troubleshoot

Inspect preparation, pending actions, and per-component validation/startup status.
Healthy components and ordinary conversation remain available when other tools fail.
Resolve missing credentials, executables or engine prerequisites through the retained
operation. Do not replay a task until its prior outcome is understood.

The bundled official catalog is empty. Register capabilities you have reviewed.
The [CLI](CLI.md) exposes inspection and recovery without editing internal databases.
