# Polariton

**Core infrastructure for humans and AI agents working together in scientific research.**

Research develops as it proceeds: questions branch, methods change, and new tools
become necessary. Polariton gives this evolving work a persistent structure, lets
workers build reusable lab tools, and keeps records you can return to and inspect.

## What you can do today

- **Explore connected research directions.** Organize work as a graph of nodes,
  each with an independent Git workspace. Relationships describe how the work connects.
- **Work with concurrent agents.** Workers on a node share files while keeping
  separate conversations and execution context.
- **Build the tools your research needs.** Ask workers to connect existing MCP
  tools or create custom lab capabilities, then prepare versioned environments
  for new workers. Account login and host prerequisites may require your setup.
- **Revisit the evidence.** Inspect graph history, file checkpoints and worker
  trajectories. Continue a new node from a selected checkpoint's files.

Polariton uses DeepSeek Harness for model execution, tools, context and session
history. Polariton owns research organization, worker coordination and capability
infrastructure.

## Current stage and direction

**Preview — 5.0.0-preview.1.** This actively developed infrastructure provides the research
workspace, concurrent workers, tool environments and inspectable records described
above. It runs locally for a single owner; domain-specific lab tools can be added
as capabilities.

Polariton is the foundation for a more automated lab system, not a complete lab
system. Domain-specific tools, instrument integrations and experimental workflows
build on this core infrastructure, allowing lab capabilities to grow through research.

Run from source with Node.js and Git using fresh data. Earlier experimental data
has no automatic migration; preserve it before upgrading. Packaged releases will
be handled separately. See [known limitations](docs/LIMITATIONS.md).

## Explore the docs

| Goal | Guide |
| --- | --- |
| Install and launch | Platform quick starts below |
| Create your first project | [Getting started](docs/GETTING_STARTED.md) |
| Understand nodes and workers | [Research project structure](docs/RESEARCH_PROJECTS.md) |
| Connect or build lab tools | [Capabilities and environments](docs/ENVIRONMENT.md) |
| Understand the research record | [Provenance](docs/PROVENANCE.md) |
| Use commands or scripts | [CLI](docs/CLI.md) |
| Understand or extend the system | [Architecture](docs/ARCHITECTURE.md), [development](docs/DEVELOPMENT.md) |

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
[Environment setup](docs/ENVIRONMENT_REFERENCE.md#managed-containers).

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

Both contain `app/` and `environment/`. Research files at selected project paths
stay there; back up both the data bundle and those workspaces. Provider keys are
local plaintext protected by file permissions. Read [storage and backups](docs/STORAGE.md)
and the [security boundary](SECURITY.md) before moving or sharing data.

For development, `npm run dev` uses separate data and `npm run dev:stop` stops it.
Normal and development launches share the default browser port; configure distinct
ports before running both together. See [development](docs/DEVELOPMENT.md) for setup
and [storage checks](docs/STORAGE.md#check-attachment-storage) for attachment verification.

## Contribute and learn more

Use Issues for bugs and proposals, and pull requests for changes. See
[CONTRIBUTING.md](CONTRIBUTING.md), [changes](CHANGELOG.md),
[known limitations](docs/LIMITATIONS.md), and the [documentation index](docs/README.md).
Report vulnerabilities through [SECURITY.md](SECURITY.md).

Polariton-owned source is [MIT licensed](LICENSE). Third-party material retains its
[own notices](THIRD_PARTY_NOTICES.md). The package is marked `private` to prevent
accidental npm publication; this does not restrict the source license.
