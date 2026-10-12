# Contributing to Polariton

Bug reports, documentation improvements, and focused code changes are welcome.
Use Issues for reproducible problems and proposals. For a substantial change,
describe the problem and proposed approach before implementing it.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Set up

Follow [development setup](docs/DEVELOPMENT.md). Read [AGENTS.md](AGENTS.md)
and the [architecture overview](docs/ARCHITECTURE.md) before changing behavior.
The repository is self-contained; no private workspace is required.

## Submit a change

1. Fork the repository on GitHub (make a copy under your account), then clone it.
2. Create a branch for one change: `git switch -c fix/short-description`.
3. Change the code and the documentation that describes its behavior.
4. Add regression coverage for a bug or changed contract. Test public behavior,
   failure recovery, and ownership; avoid tests of private implementation details.
5. Run `npm run check:public`, `npm run build`, and `npm test`.
6. Commit and push your branch, then open a pull request against `main`.
7. Explain the problem, resulting behavior, checks run, and any remaining limits.

A pull request is a proposed change. Merging accepts it into `main`, where other
users and contributors can download and build it.

The default checks need no provider key. Do not submit credentials, user research,
raw model histories, or local runtime files. Live-provider and host-service tests
require a separately agreed scope and budget; do not run them to satisfy ordinary CI.

Preserve upstream notices and provenance for copied code. Contributions are
submitted under the repository's MIT license; retain different upstream licenses
on third-party material. Maintainers may request changes before merging.
