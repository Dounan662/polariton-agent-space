# Getting started

Follow the macOS or Ubuntu quick start in the [README](../README.md), then keep
`npm start` running in Terminal.

## Connect a model

Open the complete local browser link printed in Terminal. It includes a one-use
sign-in token. If you restart Polariton, use the new link.

Open **Settings → Models & providers**, enter your provider key, and choose a
model. Saving a key does not contact the model to verify it. Sending a task uses
your provider account and may incur charges. Keys are stored locally; see
[security](../SECURITY.md) before sharing files or backups.

## Create a project and work with agents

1. Create a project and choose a folder on your computer for its research files.
2. Select its initial node and worker. Send a small task with a clear outcome.
3. Add nodes to explore other ideas or directions. Relationships describe how
   ideas connect; they do not automatically start or schedule work.
4. Add workers when needed. Workers on the same node share files, but each has
   its own conversation and execution context. Coordinate edits to shared files.
5. Use **Steer** to guide an active turn and **Interrupt** to stop that worker's
   current work. Check its status before sending a replacement task.
6. Switch between conversation and trajectory to inspect messages and tool activity.
   Reading saved history does not activate a model.

Workers can run tools and change files within their granted access. Review
permission requests and the files they produce. Use **Open workspace folder in
system file manager** in the workspace toolbar to open the selected node's files
in Finder or the Linux desktop file manager. A desktop session is required; a
failed launch is reported in the workspace.

## Save a checkpoint

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

## Add tools when needed

Ordinary conversation does not require Docker. To connect additional tools,
read [capabilities and environments](ENVIRONMENT.md). Select a prepared environment
before a worker's first message. Sending a message does not install infrastructure.

## Stop and return

Press Ctrl+C in the launch terminal, or run `npm stop` from the repository in
another terminal. Closing the browser does not stop ongoing work. Run `npm start`
again and open the new launch link to return to your saved projects.

Back up your stopped data and research folders using [storage and backups](STORAGE.md).
If a task's outcome is uncertain, inspect its status and history before retrying.
See [known limitations](LIMITATIONS.md) for other troubleshooting guidance.
