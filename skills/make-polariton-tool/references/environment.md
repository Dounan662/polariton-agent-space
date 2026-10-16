# Environment composition and recovery

This is the expert definition-only composition and lifecycle path. For ordinary tool
setup use [prepare, inspect and validate](preparation.md), one durable owner operation.

Use `harnessctl` with the installation context from SKILL.md. Discover current
records and retain exact IDs; names are display metadata.

```sh
harnessctl capability list
harnessctl environment list
harnessctl environment get ENVIRONMENT_ID
harnessctl environment get ENVIRONMENT_ID --revision REVISION_ID
harnessctl release get RELEASE_ID
```

Compose a complete document. `format:2`, `environmentId`, `name`, `description`, and
`components` are required. A component has a unique `id` and `name`, and selects
either `definition:{capabilityId,revisionId}` or `releaseId` with `configuration`.
Managed configuration must satisfy the release manifest. Reuse capabilities and
releases; never copy credential values into documents.

Save publication input as:

```json
{
  "expectRevision": null,
  "document": {
    "format": 2,
    "environmentId": "analysis",
    "name": "Analysis",
    "description": "Prepared analysis tools",
    "components": [
      {"id":"analysis","name":"Analysis","definition":{"capabilityId":"CAPABILITY_ID","revisionId":"DEFINITION_REVISION"}}
    ]
  }
}
```

`null` creates a new environment. Updating requires the exact current head revision.
Preserve the whole intended document; a stale expected revision cannot overwrite a
newer publication. Preview checks current definitions and revision without reserving
state or preparing infrastructure.

```sh
harnessctl environment publish --input publish.json --preview
harnessctl environment publish --input publish.json --request-id PUBLISH_UUID
harnessctl environment apply ENVIRONMENT_ID --revision REVISION_ID --request-id APPLY_UUID
harnessctl operation get environment:APPLY_UUID
```

Publication and Apply are separate. Apply prepares managed mounts, checks HTTP
requirements and prepares installed/package-backed stdio definitions. A partial
receipt retains individual component errors. Correct the prerequisite, then repeat
the identical Apply request to recover; never erase the original receipt or ledger.
A prepared program may still depend on an externally started application. Successful
preparation does not prove an MCP call occurred.

Workers retain their selected revision for life. New revisions require new workers;
Send/resume never install packages or apply/start managed infrastructure. Closing a
worker releases its access, not shared servers. Installation does not imply authority
to create or assign a consumer worker.

Maintenance commands are separate from ordinary assignment:

```sh
harnessctl mount list
harnessctl mount get MOUNT_ID
harnessctl mount observe MOUNT_ID --uri RESOURCE_URI
harnessctl binding list
harnessctl binding get BINDING_ID
```

Use command-specific `--help` for create/replace/stop/release arguments and examples;
add `--schema --json` only when you need the full typed contract. Binding
creation requires `--output FILE`; connection credentials are written exclusively
to that private file and never printed. Do not distribute or commit it. Forceful
mount operations require explicit `--force` and can interrupt external calls.
Main-owned worker grants are not standalone bindings to operate manually.

Timeout and observer disconnect do not cancel work. Inspect the owner operation
reference before retrying; preserve the original request UUID and input. Missing,
failed, partial and uncertain outcomes must remain explicit in the final report.
