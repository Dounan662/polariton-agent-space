# Maintaining the repository

Use a small, repeatable workflow: develop a focused change, verify it, review the
diff, and merge it. The public repository is the shared source for contributions.

## Review and merge

1. Start a branch from current `main`; keep the problem and intended behavior clear.
2. Update user documentation and meaningful regression coverage with the change.
3. Run source checks, build, and relevant tests as described in [development](DEVELOPMENT.md).
4. Open a pull request explaining the problem, resulting behavior, checks, and limits.
5. Review code, documentation, dependency changes, and data compatibility together.
6. Merge after CI and review pass. Update [the changelog](../CHANGELOG.md) for user-facing changes.

Preserve outside contributions when integrating work. Do not replace the entire
public tree with an unrelated private snapshot. Record what was actually tested;
local results do not imply that GitHub Actions has run.

## Repository settings

Enable Issues and private vulnerability reporting. Protect `main` against force
pushes and deletion, and require successful checks and pull requests where practical.
A solo maintainer can review their own focused changes without requiring another
reviewer. Keep workflow permissions narrow and review external contributions before
running tools with credentials or access to real research.

## Documentation and data

Keep public guides about current behavior. Exclude private development journals,
raw traces, credentials, machine details, and speculative plans. Preserve licenses
and third-party provenance when moving or adapting code. The packaging file list
must remain consistent with the public source, even when removing documents.

Treat stored-data changes as explicit compatibility decisions. A preview limitation
never authorizes deleting user data. Describe limits in [storage](STORAGE.md) and
[known limitations](LIMITATIONS.md). Report security issues through the private
channel in [SECURITY.md](../SECURITY.md).
