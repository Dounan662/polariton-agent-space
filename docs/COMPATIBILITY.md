# Compatibility and verification scope

## Historical platform baseline

| Platform | Node | Status |
| --- | --- | --- |
| macOS arm64 | 24.11.0 | 2026-10-12 baseline build, tests, smoke and attachment check passed |
| Ubuntu 26.04 amd64 | 24.21.0 | 2026-10-12 baseline build, tests, smoke and attachment check passed |
| Ubuntu 24.04 amd64 | Node 24 | Implemented host profile; not fully verified |
| Windows / macOS Intel | — | Unsupported |

The most recent storage update was checked on 2026-10-12. Each tested platform
completed 681 tests: 676 passed, 5 optional infrastructure tests skipped, 0 failed.
This describes that source candidate, not an automatic guarantee for later changes.
Use CI results and the checks in [development](DEVELOPMENT.md) for the current commit.

The attachment check saved an image and file, persisted their session references,
then reopened both in a fresh process using the unchanged Harness package.
It passed in standard production and development locations on both platforms.
These results do not establish access in every sandbox or user-selected directory.

## Capability and checkpoint upgrade scope

The capability preparation upgrade was qualified on macOS arm64, including controlled
OAuth discovery/refresh tests, explicit package examples, managed OCI lifecycle,
committed Git tools and owner UI exercises. Its final full suite recorded 719 passes
and five opt-in skips. These results do not certify arbitrary package versions or
external OAuth providers. Google metadata and controlled protocol exchanges do not
establish real Google consent or authenticated Workspace tool calls.

The subsequent shared Git checkpoint upgrade was qualified by a local macOS build
and full suite with 795 passes and five opt-in skips, plus 64 focused checkpoint
regressions. This is upstream source qualification, not a claim of a fresh run in
every copied checkout. It did not requalify Ubuntu deployment, live models or
interactive browser behavior. Re-run current checks when distributing this source.

Research storage is version **5** and Environment storage is version **9**. Earlier
experimental data is preserved and rejected without migration. See
[storage](STORAGE.md) and [feature limits](LIMITATIONS.md).

## Harness contract

The runtime and adapted presentation are pinned to DeepSeek Harness **0.2.1-rc.2**, with readable session
format **4**, adapter contract `polariton-harness/1`, and inspection contract
`polariton-source/1`. Dependency versions and integrity hashes are in
`package-lock.json`. `harness/qualification.json` intentionally contains no current
installed deployment profiles; `harness/release.json` records the reviewed runtime
inputs. Cordis is pinned to **4.0.5**. Research storage remains **5**, Agent Manager
storage **9**, and Environment storage **9**; readable Harness session format
remains **4**. This upgrade introduces no migration or data deletion.

The historical platform results above retain the baseline from earlier testing of
Harness history, process control, and core provider behavior. Private development
campaigns and raw traces are not distributed here. Their historical success does
not certify every provider, browser, tool, or new source revision. The storage update
made no model calls and did not requalify live-provider behavior.

## Current runtime and presentation upgrade

The 2026-10-17 development-source checks on macOS arm64 / Node 24.11.0 passed
810 tests with five optional skips, build and isolated archive installation/build.
Six real-provider checks and synthetic Chromium checks covered execution, cold
history, scrolling, code visibility, metrics and trajectory inspection. All 244
adapted source entries were reviewed against revision
`687f282e8625c6b8d11ff58211a90524be2e4317`.
These are recorded upstream checks, not new provider or browser runs in this public
checkout. Private traces are excluded from the public distribution. Installed
macOS/Ubuntu service campaigns and Safari have not been requalified for this
runtime, so historical platform passes are not carried into the current manifest.

## What ordinary checks do not establish

The default suite skips five explicit host/container/service scenarios. Passing it
does not prove Docker resource enforcement, boot persistence, backup restoration,
upgrade migration, real-provider access, or behavior across all browsers. Test those
separately when changing the corresponding contract, using disposable resources.

Known Vite bundle-size and Node SQLite experimental notices can appear during a
successful build/test run. A notice is not a substitute for examining a failing
command's exit status and diagnostics. See [limitations](LIMITATIONS.md).
