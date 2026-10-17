# Getting started

Create a research project, give a worker a small task, and save the result as a
checkpoint. No additional capability environment or Docker setup is needed for
this walkthrough.

## Launch and connect a model

Follow the platform quick start in the [README](../README.md), then keep `npm start`
running in Terminal. Open the complete browser link it prints, including the one-use
sign-in token. After a restart, use the new link.

In **Settings → Models & providers**, enter your provider key and choose a default
model for new workers. Saving a key does not verify model access. Sending work uses
your provider account and may incur charges; startup itself needs no key. See
[security](../SECURITY.md) before sharing settings or backups.

## Create your first project

Choose **Create project** and select a folder for the project. Its folder name becomes
the project name, which you can rename later. Polariton creates an initial node and
worker. Each node has its own workspace within the project.

Select the initial worker. Check its **Model** selection and leave **Environment**
as **No environment** for this task. See [research project structure](RESEARCH_PROJECTS.md)
for how projects, nodes and workers fit together.

## Give the worker a small task

Send a concrete request with a file you can inspect:

> Create a short plan for comparing two qubit readout settings. Save it as
> `readout-plan.md`, covering the measurements to collect, analysis steps, and checks
> needed before drawing conclusions. Use synthetic examples only.

This is a planning exercise, not an instrument connection or a validated experimental
protocol. The worker can use its built-in tools to write the file.

## Inspect and guide the work

Read the response, inspect tool activity in the trajectory view, and open the generated
file in the workspace. Review any permission requests. The workspace toolbar also
lets you open the node's folder in your system file manager when a desktop session
is available.

Send follow-up guidance through the same message box, including while the worker is
working. Use **Interrupt** to stop its current work. If the outcome is uncertain,
inspect its status and history before sending a replacement task. Reading saved
history does not activate a model.

## Save a checkpoint

After reviewing the file and finishing immediate writes, choose **Publish checkpoint**
in the workspace toolbar. A checkpoint retains a commit in the node's shared Git
history. Publication includes shared changes and may capture unfinished work from
other workers; avoid manual Git operations during publication.

To explore an alternative, use **Create node from checkpoint**. The new node receives
supported files in an independent repository, without the original workers or their
conversations. Add another worker to the same node instead when you want a separate
conversation working on the same files.

Read [checkpoints and inheritance](CHECKPOINTS.md) for staging rules, file exclusions,
retained history and recovery guidance.

## Add capabilities when needed

**Ask a worker to connect existing tools or build a custom lab capability.** Follow
[capabilities and environments](ENVIRONMENT.md) for examples. Select a prepared
environment before a worker's first activation; use a new worker to adopt a different
assignment afterward. Sending ordinary work does not install infrastructure.

## Stop and return

Press Ctrl+C in the launch terminal, or run `npm stop` from the repository in another
terminal. Closing the browser does not stop ongoing work. Run `npm start` again and
open the new link to return to saved projects; inspect interrupted work before resuming.

Follow [storage and backups](STORAGE.md) to preserve your data and research folders.
See [troubleshooting](LIMITATIONS.md#common-problems) if setup or execution fails.
