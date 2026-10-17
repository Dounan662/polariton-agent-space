# Checkpoints and inheritance

For a first walkthrough, see [getting started](GETTING_STARTED.md#save-a-checkpoint).
This reference explains what publication retains and how inherited files behave.

A checkpoint retains a commit in the node's shared Git history. Publication stages
all additions, modifications and deletions with `git add -A`, then commits changes
or registers the existing `HEAD` when unchanged. It includes already staged work
and replaces partial staging. Untracked ignored files stay excluded; tracked files
remain included even if they match ignore rules. Git attributes, filters and hooks
apply normally. Review important research outputs for Git inclusion before publishing.

Finish immediate writes and avoid manual staging, commits or branch changes during
publication. Workers can keep running, so a checkpoint may contain unfinished shared
edits and files read at different times. It certifies neither tests nor scientific
correctness. Resolve detached HEAD, conflicts or unfinished Git operations before
retrying. After an uncertain outcome, inspect the original operation receipt rather
than issuing a new publication identity.

Manual commits advance history without creating a Polariton checkpoint. Publishing
with no further edits registers that commit. Retained checkpoints survive later
branch rewriting; different checkpoint notes can refer to the same commit.

You can continue a new node from a selected checkpoint. It receives retained regular
and executable files in an independent repository, without the source history or
worker context. Symlinks, submodules, external Git LFS payloads and unsafe or non-UTF-8
paths are not supported for inheritance. A committed external-content pointer does
not back up its payload. File preview/upload limits do not limit checkpoint or
inheritance size, but Git work still needs time, disk space and configured resources.


See [research provenance](PROVENANCE.md) for how checkpoints complement graph
history and worker trajectories, and [storage and backups](STORAGE.md) for preserving
data beyond Git checkpoints.
