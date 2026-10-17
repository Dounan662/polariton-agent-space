# Known limitations and troubleshooting

Polariton is a preview for a single owner on a trusted local machine. Read
[compatibility](COMPATIBILITY.md) for tested platforms and versions.

## Data and concurrent work

- Earlier experimental formats are not automatically migrated. Incompatible data
  is preserved and rejected. Do not delete it to bypass startup checks.
- Moving the source folder does not migrate data. Moving the data itself can break
  stored absolute paths; see [storage](STORAGE.md) before making changes.
- Workers on one node share files. Checkpoints may contain other workers' unfinished
  edits. They do not establish exclusive authorship or freeze external writers.
- Checkpoints consume shared staging and follow Git ignore/filter/hook rules; they
  are not raw workspace backups or concurrent-write certification. Avoid external
  Git changes during publication. See [checkpoint semantics](CHECKPOINTS.md).
- Unresolved publication recovery conflicts block new checkpoint identities on the
  affected node, leaving ordinary file work available. Inspect the original receipt;
  this preview has no automatic abandonment, history repair or user-facing repair flow.
- Inheritance supports regular and executable files, not symlinks, submodules or
  external Git LFS payloads. Large retained contents still require disk space and I/O.

## History and providers

History reads have configurable event, byte, time, and concurrency limits. A source
above a limit returns an error rather than a falsely complete page. Retained files
remain on disk even when they exceed a display or download budget. Native history
decoding can allocate memory beyond JavaScript heap limits.

Long conversations render a moving set of visible rows. Browser Find only searches
mounted content; it is not a full-history search. Chromium has had the most focused
conversation testing; equivalent behavior in every browser is not established.

A provider appearing in Settings does not certify every model or API configuration.
Saving credentials does not test access. Model requests can fail or cost money.
Keys are plaintext with owner-only permissions, not an encrypted vault.

## Tools and access

Host tools and same-user processes can access files with the user's authority.
Filesystem checks and checkpoint publication are not protection against a hostile
process running as that user. Managed containers and external MCP servers require
separate trust and resource review. Multi-user or public internet hosting is outside
this preview's operating boundary.

Source adapters have bounded recipes: npm hooks are disabled, PyPI uses wheels,
Cargo native builds require explicit authority, and MCPB supports manifest 0.3 direct
entrypoints. Generic OCI supports prepared isolated stdio instances without network,
host mounts, credential injection or persistent volumes. These new preparation paths
have not been requalified on Ubuntu. Arbitrary OAuth providers are not certified;
real Google consent and authenticated Workspace calls still require owner setup and
verification. Account secrets use private files, not an OS keychain. Local disconnect
cannot recall static credentials already copied into active processes; restart those
workers, and separately revoke upstream credentials when necessary.

Rootless/remote container engines and every third-party MCP integration are not
covered by the tested platform combinations. The bundled official catalog is empty;
register capabilities you have reviewed. See [environments](ENVIRONMENT.md).

## Common problems

| Problem | Next step |
| --- | --- |
| Build fails | Check the README's Node version and platform prerequisites; on macOS check Apple Command Line Tools |
| Browser link fails | Use the complete, newly printed link on the same computer; its token is single-use |
| Port already in use | Stop the other instance or choose distinct ports and data in custom configuration |
| Attachment save fails | Run `npm run verify:storage`; inspect permissions and sandbox access to the selected directory and its ancestors |
| Tool unavailable | Inspect component preparation and worker startup status; check credentials, executable paths, and container readiness |
| Task outcome uncertain | Inspect worker history and the operation receipt before sending it again |

When reporting a bug, include the source commit, OS, Node version, reproduction
steps, and sanitized diagnostics. Never attach an entire state directory or provider key.
