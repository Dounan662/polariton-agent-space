# Register and revise MCP capabilities

Use `harnessctl` as described in SKILL.md. `capability list` shows existing capabilities;
reuse a matching definition before registering another. Registration and preview never
connect to endpoints, launch programs or install packages. Apply is a separate operation.

## Accepted configuration

The top level has exactly `mcpServers`, a nonempty **object keyed by display name**.
Every name must be unique; duplicate JSON keys are rejected. No comments or trailing
commas. Each entry has exactly one of these shapes (optional fields may be omitted):

| Transport | Required fields | Optional fields |
| --- | --- | --- |
| HTTP | `url` (absolute HTTP/HTTPS URL) | `type: "http"`, `headers` (string map), `requirements` |
| stdio | `command` (installed absolute executable or bare name) | `type: "stdio"`, `args` (string array), `env` (string map), `requirements` |

`requirements` accepts `files` (absolute prerequisite paths), `identityFiles` (absolute
regular files to fingerprint), and `execution: "foreground-host"`. Both arrays default
to empty. File presence is checked, not application login or responsiveness. For local
scripts, put the direct absolute script path first in `args` and declare lockfiles or
other important dependency identity files. Runtime and direct entry-point hashes are
recorded automatically. Stdio runs on the host with the user's authority; current
foreground-process support is macOS arm64. No filesystem sandbox is implied.

```json
{
  "mcpServers": {
    "remote-analysis": {
      "type": "http",
      "url": "https://example.invalid/mcp",
      "headers": {"Authorization": "Bearer ${ANALYSIS_TOKEN}"}
    },
    "node-analysis": {
      "command": "/absolute/bin/node",
      "args": ["/absolute/server/server.mjs", "${POLARITON_WORKSPACE}"],
      "env": {"CACHE_DIR": "${POLARITON_RUNTIME}/cache"},
      "requirements": {"identityFiles": ["/absolute/server/package-lock.json"]}
    },
    "python-package": {
      "command": "uvx",
      "args": ["mcp-server-time"]
    }
  }
}
```

URLs/packages here illustrate formats, not verified products. Replace them with the
requested deployment's values. Do not copy secrets into this file.

Unknown fields, per-server `cwd`, SSE, shell commands/expansion, background/daemon
launch flags, credential-bearing arguments and credential-bearing URLs are unsupported.
The worker's cwd is always its own workspace. `${POLARITON_WORKSPACE}` and
`${POLARITON_RUNTIME}` may appear in arguments or nonsecret stdio env values, including
literal suffixes. They resolve per worker/access; they are not credential references
and are unsupported in HTTP headers. Persistent outputs belong in the workspace.
Never mix a credential reference and a workspace/runtime reference in one value.

## Package launchers

Supported input forms:

```text
npx [-y|--yes] registry-package[@version-or-tag] [server arguments...]
uvx package[@version|@latest|==version] [server arguments...]
uvx --from package[@version|@latest|==version] executable [server arguments...]
```

Prefer an explicit known version. npm packages need a single binary or one matching
the package basename, with a Node.js entry point. Python packages need compatible
wheels and the named executable. Other runner options, Git/URL/local package sources,
install scripts and Python source builds are unsupported. Use a separately provisioned
foreground executable or managed repository when those are genuinely required.

The daemon's configured npm/node or uv/Python tools must already exist. Apply installs
once for the capability revision in Polariton-owned shared storage, records exact resolved
versions and a content digest, and reuses it. Send/resume never fetch or reinstall.
Multiple workers share installed bytes, while DSH launches separate processes in their
own workspaces. An incomplete or drifted installation requires a deliberate new
definition revision and Apply; do not delete its files or improvise a runtime installer.

## Preview, confirmation, import and revision

```sh
harnessctl capability preview --input servers.json > preview.json
```

Raw `{mcpServers:{...}}` and an envelope with `configuration`, `resolutions`, and
optional `capabilityId` are supported. The result's `data` contains `entries`,
`errors`, and `resolutions`. Correct errors before import. For `EXECUTABLE_CONFIRM`,
inspect the proposed absolute executable and repeat preview with that path in
`resolutions`; retain the bare launcher in `configuration`.

Write `import.json` containing only `{ "entries": [...] }` from the successful
preview. Do not manufacture recorded executable or credential identities.
Generate and retain a request UUID, then invoke:

```sh
harnessctl capability import --request-id REQUEST_UUID --input import.json
harnessctl capability get CAPABILITY_ID
harnessctl capability get CAPABILITY_ID --revision DEFINITION_REVISION
```

Import is atomic. Its receipt's `result.capabilities` supplies exact retained IDs.
To revise a definition, preview one edited entry with envelope `capabilityId`, then
write `{ "entry": ... }` from that preview and use:

```sh
harnessctl capability revise CAPABILITY_ID --expect-revision CURRENT_REVISION --request-id REQUEST_UUID --input revise.json
```

A changed definition does not update existing assignments. Publish and Apply a new
environment revision deliberately. Retry lost responses with the same input/UUID.

## Credentials and preparation failures

Credential values belong only in the operator-configured credential file. It must be
an owner-owned regular nonsymlink file, mode 0600, with this format:

```json
{"format":1,"credentials":{"ANALYSIS_TOKEN":{"account":"research-account","authority":"analysis-read-write","value":"SET_PRIVATELY","expiresAt":"2030-01-01T00:00:00Z"}}}
```

`expiresAt` is optional. Provision values privately; never print the credential file
or place values in operation JSON, terminal arguments, reports or ordinary config.
Definitions pin the reference's account/authority. Refreshing a value for the same
identity is supported; changing identity requires a new deliberate definition.
Credential references use `${REFERENCE}` as the whole env/header value; headers may
also use `Bearer ${REFERENCE}` or `Basic ${REFERENCE}`. Only `accept`, `content-type`,
`user-agent` and `mcp-protocol-version` headers permit arbitrary public literals.
Sensitive env names (token/key/secret/password etc.) require references. Credentials
must be provisioned before preview; Polariton performs no interactive OAuth/login.

| Diagnostic or outcome | Action |
| --- | --- |
| `EXECUTABLE_CONFIRM` | Confirm the returned path in `resolutions`, then preview again. |
| `EXECUTABLE_MISSING`, `IDENTITY_MISSING` | Provision the program/file at the intended absolute path; do not install into a worker as a workaround. |
| Credential source/missing/expired/identity error | Have the configured owner provision or refresh the named private reference; never weaken the definition or paste secrets. |
| Unsupported input/launcher | Correct the supported shape or choose a separately prepared executable/managed path. |
| Executable/package drift or incomplete package preparation | Inspect the public error, create a new explicit definition revision, publish and Apply it. |
| Missing application/prerequisite | Install or start the requested external prerequisite within authorized scope; package installation alone is insufficient. |
| Unreachable endpoint/discovery failure | Report that component unavailable; check service/bridge reachability through its documented interface. Healthy tools and ordinary chat remain usable. |

A server error is not permission to edit Polariton, automatically reinstall, run an
unbounded retry loop or claim completion of a task requiring that server.
