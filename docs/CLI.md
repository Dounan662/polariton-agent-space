# Command line

Polariton's CLI supports people, agents and scripts through **progressive disclosure**:
start with a small overview, narrow to the relevant command or resource, and request
more detail only when needed. You do not need to memorize the command catalog or
load every schema before acting.

Run `npm run harnessctl -- ...` from the repository, or invoke `bin/harnessctl`.
The examples below use the npm form. Help works without a running daemon or provider
key; it describes the installed source version.

## Discover progressively

Browse the four areas—`research`, `workers`, `tools`, and `system`—or search by
intent, then follow the suggested commands. For example, to discover how to save
research progress:

```sh
npm run harnessctl -- --help
npm run harnessctl -- help research
npm run harnessctl -- help --search "save progress"
npm run harnessctl -- checkpoint --help
npm run harnessctl -- checkpoint publish --help
```

| Level | What you learn |
| --- | --- |
| Root help | Main areas, invocation conventions, and where to go next |
| Category or resource help | Relevant commands and their purposes |
| Command help | Inputs, constraints, a usage example, and the expected result |
| Command help with `--details` | Additional operational and recovery guidance |
| Help with `--schema --json` | Structured input/output contracts for automation |

Request deeper guidance or the exact contract separately:

```sh
npm run harnessctl -- checkpoint publish --help --details
npm run harnessctl -- checkpoint publish --help --schema --json
```

Search matches command names, descriptions and authored aliases; it does not make
model calls. Search can be scoped, for example `help research --search "checkpoint"`.
Follow returned pagination guidance when more matches exist. The tools overview
highlights common operations; resource help exposes the fuller command inventory.

Use executable help as the command reference. Replace example placeholders with
actual IDs and values. `--details` in help requires a specific command; `--schema`
cannot be combined with `--details` or `--search`.

## Inspect progressively

The same approach applies to live state: list resources, inspect the one relevant
to your task, then follow its detail or continuation guidance.

```sh
npm run harnessctl -- project list
npm run harnessctl -- worker overview WORKER_ID
npm run harnessctl -- worker get WORKER_ID
```

Replace `WORKER_ID` with an actual worker UUID. A managed worker can omit that ID
from `worker overview` to inspect its own placement, execution, tools, coworkers
and attention items. Administrative callers must supply it. Reading the overview
does not activate a worker or probe external tools.

Operation receipts are compact by default. On supported mutation receipts and
`operation get`, `--details` returns the full retained receipt. This is distinct
from expanding help, and is not a universal switch for every read command. Follow
returned pagination rather than treating a bounded page as the complete collection.

## Select your running instance

Start Polariton with `npm start` before research, worker or tool operations; these
commands do not start missing daemons. Configuration selection uses `--config FILE`,
then `HARNESSCTL_CONFIG`, then the repository's default app configuration. The shell's
current directory does not select a different instance.

For development, set `POLARITON_PROFILE=development` on CLI invocations as well,
or provide an explicit matching configuration. Workers launched by Polariton receive
their own authenticated CLI context. Do not copy worker credentials to another worker
or expose private binding files.

## Run operations and recover

Reads inspect state. Mutations change it and generally return an operation receipt.
Check command help for request-ID requirements. These commands generate a UUID when
omitted and emit recovery information before dispatching a mutation:

- `worker send`
- `capability add` and `capability complete`
- `environment prepare` and `environment validate`
- `operation continue` and `operation cancel`

Other mutations require `--request-id UUID`; previews do not execute the mutation.
Retain the original input, request ID, stdout and stderr. If a reply is lost, use the
reported `operation get` command to inspect that operation before retrying. An
identical retry must keep the original identity and input; a new ID can repeat an
effect, such as sending a second message.

`--wait` observes the command outcome. For `worker send`, it waits for admission,
not message application or the worker's completed response. An observation timeout
does not cancel underlying work. Interrupting a worker or cancelling a preparation
operation requires the corresponding explicit command.

Checkpoint publication stages the whole node and can include unfinished shared
edits. Review [checkpoint semantics](CHECKPOINTS.md) before
publishing. A failed reply does not imply rollback. For preparation, authentication,
validation and continuation, follow [capability operations](ENVIRONMENT.md).

## Structured output and exit status

`--json` selects JSON help. Domain commands already return JSON with a versioned
`data` envelope; errors include a code, message and applicable recovery guidance.
Diagnostics and pre-dispatch recovery information go to stderr. Capture both streams
separately. `worker get --follow` emits bounded newline-delimited JSON observations;
live observations are not a replacement for retained execution history.

Use `--input FILE` or `--input -` for structured JSON input from a file or stdin.
For literal message text, `worker send` also supports `--text-stdin`; it cannot be
combined with `--text` or `--input -`. Use bare switches or `--flag VALUE`, not
`--flag=VALUE`. Consult command help before constructing inputs.

| Exit | Meaning |
| --- | --- |
| 0 | Read succeeded or mutation accepted |
| 1 | Unexpected failure |
| 2 | Invalid input |
| 3 | Conflict or unmet precondition |
| 4 | Authentication failure |
| 5 | Unavailable |
| 6 | Failed, partial, blocked or cancelled outcome |
| 7 | Uncertain outcome |
| 8 | Observation timeout |

Accepted does not necessarily mean all work has completed. Inspect the receipt
and current resource state before deciding what to do next.
