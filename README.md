# Polariton

A local research workspace for organizing ideas as a graph, working in independent
Git workspaces, and collaborating with concurrent AI workers.

**Preview — 5.0.0-preview.1.** Run Polariton directly from this repository with
Node.js and Git. The quick starts below use fresh data; migration from earlier
experimental versions is not supported. Packaged releases will be handled separately.

## What you can do

- Organize research as an editable graph of nodes and descriptive relationships.
- Run independent workers that share a node's files while keeping separate context.
- Inspect conversations, tool activity, and saved execution history.
- Publish checkpoints in shared Git history and continue from a retained commit.
- Connect model providers; prepare package, container and external MCP capabilities.
- Inspect preparation, resolve account setup, and validate tools before assigning them.

Polariton uses DeepSeek Harness (DSH) for model execution, tools, context, and history.
The application owns research records, worker control, and capability infrastructure.

## Start here

| Goal | Guide |
| --- | --- |
| Try Polariton on an Apple Silicon Mac | Quick start below |
| Try Polariton on an Ubuntu desktop | Ubuntu quick start below |
| Create your first project | [First steps](docs/GETTING_STARTED.md) |
| Develop or contribute | [Development](docs/DEVELOPMENT.md), [contributing](CONTRIBUTING.md) |
| Understand the system | [Architecture](docs/ARCHITECTURE.md) |
| Maintain the repository | [Maintainer guide](docs/MAINTAINING.md) |

## Get the source

Use this repository's **Code** button to clone it with Git or choose **Download ZIP**
and extract it. Open Terminal in the repository folder containing `package.json`.
Then follow the instructions for your operating system below.

## Quick start: macOS arm64

Use Node **24.11.0** (with npm **11.7.0**), Git, and Apple Command Line Tools.
Run these commands from the extracted or cloned repository root:

```sh
npm ci
npm run build
npm test
npm start
```

If the native picker build reports a missing compiler, install Apple's tools with
`xcode-select --install` and rerun the build.

The terminal prints a one-use local browser link and normally opens it for you.
Open **Settings → Models & providers**, enter a provider key, and select a model.
Sending work uses your provider account and may incur charges. Startup itself needs
no provider key. Follow [first steps](docs/GETTING_STARTED.md) to create a project.

`npm start` stays attached to the terminal. Press Ctrl+C to stop both daemons, or
run `npm stop` in another terminal.
Run only one instance at a time with the default settings.

Docker is needed for managed container capabilities, not ordinary chat. On macOS,
provision the dedicated Colima profile before using those capabilities; see
[Environment setup](docs/ENVIRONMENT.md#managed-containers).

## Quick start: Ubuntu desktop (amd64)

Use Ubuntu **26.04**, Node **24.21.0** with its bundled npm, and Git.
If Node is installed through a version manager, activate that version first.
Run these commands in Terminal from the extracted or cloned repository root,
as your normal user:

```sh
npm ci
npm run build
npm test
npm start
```

The terminal prints a one-use local browser link and normally opens it for you.
If the browser does not open, copy the complete link, including its token, into
Firefox or another browser on the same Ubuntu computer.

Open **Settings → Models & providers**, enter a provider key, and select a model.
Sending work uses your provider account and may incur charges. Startup itself needs
no provider key. Follow [first steps](docs/GETTING_STARTED.md) to create a project
using a folder on your Ubuntu computer.

`npm start` stays attached to the terminal. Press Ctrl+C to stop both daemons, or
run `npm stop` in another terminal. Closing the browser does not stop Polariton.
Run only one instance at a time with the default settings.

Docker is needed for managed container capabilities, not ordinary chat. On Ubuntu,
those capabilities require a separately provisioned local Docker Engine and
account access to `/var/run/docker.sock`.

## Platforms and data

The baseline was verified on macOS arm64 with Node **24.11.0** and Ubuntu 26.04
amd64 with Node **24.21.0**. The latest capability preparation and shared Git
checkpoint upgrades were qualified on macOS; they have not been requalified on
Ubuntu. Ubuntu 24.04 is implemented but not fully qualified; Windows and Intel
Macs are not supported.
See [compatibility and verification scope](docs/COMPATIBILITY.md) for what was checked on this copy.

Persistent data lives outside the repository:

| Platform | Default data directory |
| --- | --- |
| macOS | `~/Library/Application Support/Polariton/data/` |
| Ubuntu | `~/.local/share/polariton/data/` (honors `XDG_DATA_HOME`) |

Both contain `app/` and `environment/`. Use `npm run dev` for separate development
data (`Polariton-dev` / `polariton-dev`) and `npm run dev:stop` to stop it. Tests
use temporary directories. Development and normal launches still share the default
browser port, so configure different ports before running both together.

Run `npm run verify:storage` to check attachment saving and reopening with the
unmodified Harness. Existing `.local` data is preserved, never moved or deleted
automatically; read [storage and retained-data guidance](docs/STORAGE.md).
Research workspaces at selected project paths stay there. Back up both the data
bundle and those workspaces. Provider keys are local plaintext protected by file
permissions, not an encrypted vault. Read the [security boundary](SECURITY.md).

Earlier experimental data is not automatically migrated. Preserve it and follow
the [storage guidance](docs/STORAGE.md) before changing paths or versions.

## Contribute and learn more

Use Issues for bugs and proposals, and pull requests for changes. See
[CONTRIBUTING.md](CONTRIBUTING.md), [changes](CHANGELOG.md),
[known limitations](docs/LIMITATIONS.md), and the [documentation index](docs/README.md).
Report vulnerabilities through [SECURITY.md](SECURITY.md).

Polariton-owned source is [MIT licensed](LICENSE). Third-party material retains its
[own notices](THIRD_PARTY_NOTICES.md). The package is marked `private` to prevent
accidental npm publication; this does not restrict the source license.
