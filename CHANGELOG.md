# Changelog

User-facing changes to the source repository. Packaged release publication is
handled separately.

## Unreleased — first public preview

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
