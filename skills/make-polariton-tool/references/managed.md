# Author a managed capability

Choose this path when implementing new domain behavior, not when registering an
existing MCP package. The complete starter is bundled at `../assets/managed/` relative
to this reference directory. It includes the public binding-authorization server
helper copied from Polariton, SDK/lockfile, executable server, manifest and MCP test.
No Polariton source import or codebase inspection is required in the authored repository.

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

The starter contains the qualified digest-pinned Node image and exact MCP SDK 2.0.0,
Zod 4.6.5 and MCP test client 2.0.0 dependencies. Its build uses `npm ci --ignore-scripts`,
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

## Register and install the exact source

Generate and retain a separate request UUID before registration and installation:

```sh
harnessctl capability register --repository "$PWD" --request-id REGISTER_UUID
harnessctl release install CAPABILITY_ID --commit EXACT_GIT_COMMIT --request-id INSTALL_UUID
harnessctl release get RELEASE_ID
```

Run registration from the package directory containing `polariton-capability.json`.
The daemon resolves its enclosing Git root and relative package path. The registration
receipt's `result.id` identifies the capability. Installation snapshots only that
package from the exact commit; siblings and uncommitted files are excluded. Symlinks
and submodules are unsupported package inputs. Keep all build inputs inside the package.

EnvironmentDaemon ensures its configured runtime is ready, then fetches the pinned
image and locked packages and builds the release. Do not start Docker or Colima,
change Docker contexts, or broaden workspace permissions yourself. A missing runtime
installation/profile or invalid configuration returns a concrete error for the
operator; an ordinary stopped dedicated runtime starts automatically. External
Docker engines remain operator-owned.
The result retains repository/package identity, commit, artifact digest, runtime image
and manifest.
After a lost reply, inspect `environment:REQUEST_UUID` or repeat the identical
command. Installing creates a retained release, not an environment or worker.

Publish a managed component selecting that release with configuration matching the
manifest; the starter requires `{"scale":2}`. Follow [Environment operations](environment.md)
for publication and explicit Apply. Inspect bounded managed MCP resources with:

```sh
harnessctl mount observe MOUNT_ID --uri capability://version
```

## Completion evidence

Verify meaningful operation results over MCP, not just a started process. The starter's
`npm test` does this without an LLM, network service or Docker. Real managed Apply and
observation separately verify the deployment boundary. Paid end-to-end worker tests
use only an explicitly approved provider budget and independently checked tool receipts;
ordinary installation does not require launching or assigning a consumer worker.
Report what was tested, the exact source/release/environment identities and any missing
operator-provisioning, domain-service or application prerequisites. Leave worker selection
to the user. Preparation does not replace tools in an already active DSH session.
