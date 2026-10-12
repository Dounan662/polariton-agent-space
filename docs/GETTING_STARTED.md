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
permission requests and the files they produce.

## Save a checkpoint

A checkpoint records the node's files in Git so you can inspect or continue from
that saved state. Review the files before publishing. A checkpoint can include
unfinished changes from other workers; it does not imply the work is complete
or tested. Under continuous edits, capture can fail and need a later retry.

You can optionally continue a new node from a selected checkpoint. Its workers
have separate execution context from the original node's workers.

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
