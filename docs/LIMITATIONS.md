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
- Sustained writes can exhaust checkpoint capture retries. Inspect the result and
  retry at a calmer editing boundary instead of assuming the checkpoint exists.

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
Filesystem checks and cooperative checkpoints are not protection against a hostile
process running as that user. Managed containers and external MCP servers require
separate trust and resource review. Multi-user or public internet hosting is outside
this preview's operating boundary.

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
