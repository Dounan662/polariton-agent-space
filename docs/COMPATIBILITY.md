# Compatibility and verification scope

## Tested combinations

| Platform | Node | Status |
| --- | --- | --- |
| macOS arm64 | 24.11.0 | Repository build, default tests, startup smoke, and attachment persistence passed |
| Ubuntu 26.04 amd64 | 24.21.0 | Repository build, default tests, startup smoke, and attachment persistence passed |
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

## Harness contract

The runtime is pinned to DeepSeek Harness **0.2.0-rc.2**, with readable session
format **4**, adapter contract `polariton-harness/1`, and inspection contract
`polariton-source/1`. Dependency versions and integrity hashes are in
`package-lock.json`. `harness/qualification.json` refers to this public summary;
`harness/release.json` records the reviewed runtime inputs.

The platform entries also retain the baseline from earlier integration testing of
Harness history, process control, and core provider behavior. Private development
campaigns and raw traces are not distributed here. Their historical success does
not certify every provider, browser, tool, or new source revision. The storage update
made no model calls and did not requalify live-provider behavior.

## What ordinary checks do not establish

The default suite skips five explicit host/container/service scenarios. Passing it
does not prove Docker resource enforcement, boot persistence, backup restoration,
upgrade migration, real-provider access, or behavior across all browsers. Test those
separately when changing the corresponding contract, using disposable resources.

Known Vite bundle-size and Node SQLite experimental notices can appear during a
successful build/test run. A notice is not a substitute for examining a failing
command's exit status and diagnostics. See [limitations](LIMITATIONS.md).
