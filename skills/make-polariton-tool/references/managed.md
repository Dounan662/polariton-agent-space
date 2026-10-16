# Author a managed capability

Choose this path when implementing new domain behavior, not when registering an
existing MCP package. The complete starter is bundled at `../assets/managed/` relative
to this reference directory. It includes the public binding-authorization server
helper copied from Polariton, SDK/lockfile, executable server, manifest and MCP test.
No Polariton source import or codebase inspection is required in the authored repository.

The complete workflow is **author and test → commit → prepare → validate**. The
current Git adapter builds a managed container and exposes HTTP MCP. It does not
build a local stdio executable. An already provisioned local executable uses the
separate installed-source path in [Capability preparation](preparation.md).

## Create and verify a workspace package

Use a package directory in the current workspace's existing Git repository. Do not
create a nested repository or move outside the workspace to satisfy installation.
For example, from the workspace root, with `SKILL_DIR` set to this installed skill's
absolute path:

```sh
mkdir -p capabilities/my-tool
cp -R "$SKILL_DIR/assets/managed/." capabilities/my-tool/
cd capabilities/my-tool
npm ci --ignore-scripts
npm test
```

The dependency install needs registry access or a populated npm cache. Once installed,
the in-memory MCP test needs no network service, container or model provider.
Use a genuinely new target or reconcile existing files; do not overwrite a user's
repository. Adapt `capability.mjs`, names/version and the manifest to the domain.
Update the contract test for real tool results and error boundaries. Change direct
dependencies deliberately and regenerate/commit `package-lock.json` when needed.
Do not copy node_modules into Git. Commit only the intended package source, manifest,
helper and locks in the enclosing workspace repository; preserve unrelated edits.
Installation consumes a full 40-character Git commit from `git rev-parse HEAD`, never
uncommitted working-tree files. An independently provisioned repository also works,
but authoring a tool does not require one.

The starter's example `scale_values` operation demonstrates bounded inputs, domain
failure and complete results. It is not the requested scientific capability itself.
Replace it with the coherent domain operation. DSH renders MCP **text content** to the
model: return task-complete bounded text alongside structuredContent. Do not hide
scientific values in structuredContent while returning only a vague textual summary.
Use `extra.signal` in long-running tool handlers and keep mutation/receipt semantics
explicit: disconnect or caller cancellation does not prove remote effects were undone.

## Manifest contract

`polariton-capability.json` has exactly these required fields:

| Field | Contract |
| --- | --- |
| `format` | `1` |
| `name`, `description` | Display strings; name nonempty |
| `image` | Immutable `image@sha256:` followed by 64 lowercase hexadecimal digits; no floating tag |
| `build` | Array of argv arrays, each nonempty; no implicit shell |
| `entrypoint` | Nonempty argv array, run with `/app` as cwd |
| `lockfiles` | Nonempty array of package-relative regular file paths |
| `configSchema` | JSON Schema object for managed component `configuration` |
| `mcpPath`, `port`, `state` | Exactly `"/mcp"`, `8080`, `"scratch"` |

The starter's manifest pins the Node image by digest; `package.json` and its lockfile
are the authority for exact SDK, validation and test-client versions. Its build uses `npm ci --ignore-scripts`,
runs the actual MCP test, then removes development dependencies. The source snapshot is
copied into a bounded writable build area; the completed artifact becomes read-only
`/app` at runtime. Host node_modules, sibling repositories or local symlinks are not
build inputs. All dependencies and locks must be committed.

`POLARITON_CONFIG_FILE` identifies read-only mounted JSON component configuration.
`POLARITON_AUTH_FILE` and limit/port variables are supplied by Polariton to the bundled helper.
Do not author or expose grants. `serveCapability({createServer})` creates a fresh MCP
server per connection, validates binding authority on every request/reconnect, and
separates observer access from action tools. Keep it in the repository. It supports
`/health` and `/mcp` and should remain the server entry boundary, rather than wrapping
it in another MCP client/proxy.

Managed containers run non-root with read-only source/artifact/root, no host filesystem
or Docker socket, dropped Linux capabilities and configured resource/deadline bounds.
Only `/state` and `/tmp` are writable scratch and reset on restart. No provider keys
are injected. Portable configuration has no host paths or credentials. Operations
requiring host desktop access generally belong in an explicitly provisioned stdio or
external HTTP integration, not an attempt to escape the managed-container contract.

## Prepare the committed tool

After committing, resolve the absolute package directory containing
`polariton-capability.json` and the full commit from `git rev-parse HEAD`. Save a
preparation specification outside the package, such as `prepare-tool.json` at the
workspace root. This complete example runs the unmodified starter; replace its
source placeholders, names, configuration and check with the tool you authored:

```json
{
  "name": "Domain tools",
  "description": "Tools authored in this workspace",
  "components": [{
    "id": "analysis",
    "name": "Domain capability",
    "source": {
      "kind": "git",
      "directory": "/absolute/workspace/capabilities/my-tool",
      "commit": "EXACT_40_CHARACTER_COMMIT"
    },
    "runtime": {"kind": "container", "configuration": {"scale": 2}},
    "connection": {"kind": "http"},
    "requirements": {},
    "authentication": {"kind": "none"},
    "checks": [{
      "name": "scale",
      "effects": "read",
      "steps": [{"tool": "scale_values", "arguments": {"values": [-2, 0, 3]}}]
    }]
  }]
}
```

`runtime.configuration` must match your manifest's `configSchema`; use `{}` when
the tool has no configuration. The starter requires `scale`, but your tool need
not. The managed runtime supplies the endpoint and binding authorization; omit a
URL and headers. Here `authentication:none` means no additional user account login,
not an unprotected managed server. This adapter does not inject external account
credentials. Functional checks name raw MCP tools and declare their actual effects.

```sh
harnessctl environment prepare --input prepare-tool.json
```

This one operation registers the source, installs its immutable release, publishes
the environment and prepares the managed runtime. Do not separately register,
install, publish or Apply for this common workflow. The expert operations remain
available through CLI help and [Environment operations](environment.md).

Preparation generates a request UUID and emits its recovery reference on stderr.
Retain the response and that reference. A blocked/partial result is not completion:
inspect it, resolve only the offered action, and follow
[preparation recovery](preparation.md#continue-a-blocked-operation). After a lost
reply, inspect `environment:REQUEST_UUID`; do not repeat with a fresh identity.
Code changes require a new commit and preparation. To update an existing
environment, supply its `target`, `expectRevision` and complete components as
described in [Capability preparation](preparation.md#complete-specification).

The daemon resolves the enclosing Git root and snapshots only the selected package
at the exact commit. Siblings and uncommitted files are excluded. Symlinks and
submodules are unsupported package inputs. Keep all build inputs inside the package.

EnvironmentDaemon ensures its configured runtime is ready, then fetches the pinned
image and locked packages and builds the release. Do not start Docker or Colima,
change Docker contexts, or broaden workspace permissions yourself. A missing runtime
installation/profile or invalid configuration returns a concrete error for the
operator; an ordinary stopped dedicated runtime starts automatically. External
Docker engines remain operator-owned.
The result retains exact environment/revision IDs. Its managed component's
`capabilityId` selects the installed release; `release get` exposes source, commit,
artifact and build provenance when needed. Successful preparation reports the
connection as **untested**. Use the returned environment/revision, not a catalog
name or a separately launched server:

```sh
harnessctl environment inspect ENVIRONMENT_ID --revision REVISION_ID
harnessctl environment validate ENVIRONMENT_ID --revision REVISION_ID --check scale
```

Replace `scale` with the declared check name. Without `--check`, validation only
connects and discovers tools. A named check invokes the tool and records whether
the call succeeded; it is not a numerical-result assertion engine. Your MCP tests
must verify the actual domain values, invalid inputs and failure boundaries.

## Completion evidence

Report the package directory, exact commit/release/environment/revision, MCP test
results, functional validation and unresolved prerequisites. Keep connection,
domain correctness and real-worker use distinct.

Preparation and validation create no research workers. An active worker's tool set
remains pinned, including the author who built the tool. When the task explicitly
requests a real-worker test, create a separate consumer assigned the prepared exact
environment revision through the public worker commands. Have it invoke MCP tools
and retain actual results within the authorized provider budget. A shell import of
your source or a direct HTTP request is not evidence that the assigned worker used
the installed capability. Otherwise return the environment for user selection.
