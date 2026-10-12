# Development

## Set up

Use the platform prerequisites in the [README](../README.md). The repository is
self-contained: no private source tree or globally installed Harness is required.
`.nvmrc` selects Node 24.11.0 for the macOS profile; use Node 24.21.0 on Ubuntu.

```sh
npm ci
npm run check:public
npm run build
npm test
npm run dev
```

`npm run dev` uses the previously built UI; it does not start a hot-reload server. Rebuild after source changes. Stop it with Ctrl+C or `npm run dev:stop`.
Development data is separate from normal data; see [storage](STORAGE.md).

## Checks

| Command | What it checks |
| --- | --- |
| `npm run check:public` | Source hygiene, basic secret/private-path patterns, local Markdown links |
| `npm run build` | TypeScript, source boundaries, dependency/provenance records, native picker, browser build |
| `npm test` | The full default contract and integration suite with temporary data |
| `npm run smoke` | Built UI and authenticated API with disposable state and model activation forbidden |
| `npm run verify:storage` | Real attachment persistence in the selected data location without a model call |

Run checks affected by your change. For ordinary code contributions, run source
checks, build, and the default suite. Documentation-only changes need link and
content review. The source scanner is not a complete secret audit; inspect your diff.

Tests require loopback networking, Unix sockets, and subprocess access. They do
not need provider keys. Container, installed-service, and live-provider scenarios
are separate opt-ins; use disposable resources and an agreed scope before running
them. Never treat skipped tests as passes or use personal research as fixtures.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/` | Application API, research records, workers, CLI, and lifecycle |
| `src/environment/` | Capability preparation, revisions, and access |
| `harness/` | Pinned DeepSeek Harness integration and public adapters |
| `web/` | Browser UI and attributed presentation code |
| `environment/`, `catalog/`, `skills/` | Capability support, catalog, and tool-authoring guidance |
| `config/` | Default configuration and explicit test profiles |
| `tests/` | Contracts, integration tests, and synthetic fixtures |
| `scripts/` | Build and verification tools |
| `docs/` | Public user and contributor guides |

## Configuration

Source startup reads `config/app.json` and `config/environment.json`. Ordinary
startup does not load `.env`; configure provider keys through the browser.
For custom settings, copy both JSON files to a private location and set the app
file's `environmentConfig` to the environment file's absolute path.

```sh
npm start -- /absolute/path/to/app.json
npm stop -- /absolute/path/to/app.json
```

Use the corresponding `dev` and `dev:stop` scripts for development. Relative paths
inside configuration resolve against that configuration file. Explicit paths take
precedence over profile defaults. Set a different app `port` if running alongside
another instance, and keep their data, projects, and environment settings separate.

## Design and dependency changes

Read [architecture](ARCHITECTURE.md) and [AGENTS.md](../AGENTS.md). Test public
behavior, ownership, failure recovery, and cancellation rather than private helper
structure. Update every affected caller and the relevant public guide.

Use `npm ci` for normal installation. Review dependency changes together with the
lockfile, Harness integration, readable session format, and compatibility checks.
`harness/qualification.json` identifies supported combinations and their public
[compatibility summary](COMPATIBILITY.md). After reviewing changed inputs,
`node scripts/release-manifest.mjs --write` refreshes the runtime integrity record.
Regeneration is not a test and must never substitute for compatibility verification.

For adapted presentation code, preserve licenses and review the per-file provenance
in `web/src/native/ORIGIN.json`. Do not refresh hashes merely to bypass a build error.
Data-format changes need an explicit preservation and compatibility decision;
never erase user data to make a test or startup pass.
