# Changelog

User-facing changes to the source repository. Packaged release publication is
handled separately.

## Unreleased — first public preview

- Upgrade the complete Harness runtime and browser presentation to DSH 0.2.1-rc.2
  with Cordis 4.0.5; enforce matching direct, transitive and presentation releases.
- Refresh chat/tool status, structured user references, trajectory timing, usage
  presentation and Markdown/image rendering while preserving worker-scoped history.
- Prefer saved provider keys over launch-environment fallbacks; allow Settings to
  replace or remove saved keys, and wait for credential readiness during discovery.
- Preserve storage versions and format-4 history. Installed platform qualification
  remains separate from local runtime verification; see [compatibility](docs/COMPATIBILITY.md).


- Open the selected node workspace in the system file manager from the workspace
  toolbar, with authenticated node-scoped access and observable launch failures.
- Preserve worker reading position when switching between conversation and trajectory.

- Publish checkpoints through ordinary shared Git staging/history, preserving exact
  retained commits and recovery identities. No-change publication reuses `HEAD`;
  manual commits participate naturally, and preview limits no longer gate large
  checkpoint publication or streamed inheritance.
- Add daemon-owned capability preparation, preview, inspection, versioned continuation
  and cancellation for explicit package, image, bundle, Git and endpoint sources.
- Add separate connection/discovery and named functional validation without a model
  call, plus capability-page account setup and scoped OAuth credential refresh.
- Preserve exact capability/environment assignments through account or definition
  updates. Preparation and owner authentication never silently move active workers.
- Require fresh research format 5 and Environment format 9 state; retain incompatible
  experiments without migration. New capability/checkpoint qualification is macOS only.

- Store runtime data in standard macOS/Linux locations, with separate development
  profiles and temporary test storage. Preserve old data without automatic migration.
- Add matching macOS and Ubuntu desktop quick starts for running from the repository.
- Replace internal development records with public user and contributor guides.

Candidate version: `5.0.0-preview.1`.

- Polariton research graph with independent Git workspaces and concurrent workers.
- Persistent conversations and trajectory inspection through the pinned DSH harness.
- Local provider setup and managed or external MCP capabilities.
- Source distribution with installation instructions, tests, and architecture docs.
- MIT license, contribution guidance, automated checks, and public user documentation.

This candidate requires fresh state. Earlier Labra state is preserved and rejected,
not migrated. See the
[storage guide](docs/STORAGE.md), [known limitations](docs/LIMITATIONS.md),
and [compatibility](docs/COMPATIBILITY.md).
