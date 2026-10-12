# Command line

Run `npm run harnessctl -- ...` from the repository, or invoke `bin/harnessctl`.
The examples below use the npm form. Help works without a running daemon or provider key.

```sh
npm run harnessctl -- --help
npm run harnessctl -- help research
npm run harnessctl -- help workers
npm run harnessctl -- help tools
npm run harnessctl -- help system
npm run harnessctl -- help --search "save progress"
```

## Discover a command

```sh
npm run harnessctl -- worker send --help
npm run harnessctl -- worker send --help --details
npm run harnessctl -- worker send --help --schema --json
```

Command help contains current input requirements and examples. Prefer it over
copying old scripts or editing Polariton's databases. `--json` chooses output
format; `--details` expands an otherwise compact result.

## Select your running instance

Start Polariton with `npm start` before domain commands. Configuration selection
uses `--config FILE`, then `HARNESSCTL_CONFIG`, then the repository's default app
configuration. The shell's current directory does not select a different instance.
For the development profile, set `POLARITON_PROFILE=development` on CLI invocations
as well, or provide an explicit matching configuration.

```sh
npm run harnessctl -- project list
npm run harnessctl -- capability list
npm run harnessctl -- environment list
npm run harnessctl -- catalog list
```

Workers launched by Polariton receive their own authenticated CLI context. Do not
copy worker credentials to another worker or expose private binding files.

## Mutations and recovery

Reads inspect current state. Mutations such as creating a project or publishing a
checkpoint return an operation receipt. Most require `--request-id` with a UUID;
read the specific command's help before running it.

`worker send` generates a request UUID when omitted and prints recovery information
to stderr before dispatch. Capture that information when automating sends. If the
reply is lost, inspect the original operation with `operation get` and follow its
recovery guidance. Retrying an uncertain send with a new ID can send a second message.
An identical retry must retain the original ID and input.

`--wait` observes progress. An observation timeout stops waiting, not the underlying
worker. Interrupting work and stopping observation are separate actions. A checkpoint
can include shared unfinished edits; review its result before treating it as a milestone.

## Output and exit status

Domain commands return JSON with a versioned `data` envelope; errors include a code,
message, and applicable recovery guidance. Diagnostics go to stderr. Follow commands
emit bounded newline-delimited JSON; distinguish persisted history from provisional output.

| Exit | Meaning |
| --- | --- |
| 0 | Read succeeded or mutation accepted |
| 1 | Unexpected failure |
| 2 | Invalid input |
| 3 | Conflict or unmet precondition |
| 4 | Authentication failure |
| 5 | Unavailable |
| 6 | Failed or partial outcome |
| 7 | Uncertain outcome |
| 8 | Observation timeout |

Accepted does not necessarily mean all work has completed. Inspect the receipt and
current resource state. For tool operations, see [environments](ENVIRONMENT.md).
