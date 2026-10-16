# Storage and backups

## Where your data lives

Running from the repository stores persistent data outside the source checkout:

| Platform | Default data directory |
| --- | --- |
| macOS | `~/Library/Application Support/Polariton/data/` |
| Ubuntu | `~/.local/share/polariton/data/` |

On Linux, an absolute `XDG_DATA_HOME` replaces `~/.local/share`.
The directory contains `app/` and `environment/`. Main's data includes research
records, worker homes, session history, attachments, and provider settings.
Environment data includes capability definitions, prepared artifacts, preparation
receipts, account credentials and access records. Capability persistent data and
container volumes need their own backup coverage.

Projects created at a selected location keep their files there. Projects without
an explicit location live beneath `app/projects/`. Backing up the data directory
alone does not include external project folders or persistent container volumes.

Provider keys under `app/provider-settings/` are plaintext files protected by
owner-only permissions. Treat the complete data directory and its backups as
private. Do not commit them or attach them to an issue.

## Separate development data

Use `npm run dev` and `npm run dev:stop` for development. These select
`Polariton-dev/data/` on macOS and `polariton-dev/data/` on Linux. Normal
`npm start` and `npm stop` use the normal profile unless your shell explicitly
sets `POLARITON_PROFILE=development`.

Profiles separate data and control sockets, but use the same default browser
port. Use one at a time, or configure distinct ports. Development and normal use
may share the macOS Colima VM. Never run two copies against the same data.

`npm test` creates temporary application and Harness roots and removes them after
completion. Do not use real research directories as test fixtures.

## Choose a different location

Set `POLARITON_DATA_DIR` to an absolute directory. Use the same value for start
and stop, for example:

```sh
POLARITON_DATA_DIR=/absolute/path/to/polariton-data npm start
POLARITON_DATA_DIR=/absolute/path/to/polariton-data npm stop
```

This override is used verbatim in either profile, so select separate directories
for normal use and development. An explicit `stateRoot` in a configuration file
has precedence and resolves relative to that file. See [development configuration](DEVELOPMENT.md#configuration).

Harness data remains inside each worker's own home; Polariton selects it through
DSH's supported configuration. There is no patch to the Harness storage package.

## Back up safely

1. Stop Polariton with the same profile and configuration used to start it. Wait
   for both daemons and their operations to finish. A shutdown error needs investigation.
2. Copy the complete data directory and any custom configuration into a private
   backup location. Preserve permissions. Do not copy live SQLite files as a backup.
3. Back up every external research project and any persistent capability volumes
   separately. Keep the source revision and dependency lock used with the data.
4. Check that the backup contains what you need before changing the originals.

Restore with all writers stopped, using matching code and configuration. Preserve
the current data before restoring into an empty destination. Do not merge a backup
into a newer data directory or overwrite newer research files as a side effect.

## Existing data and relocation

Startup never automatically imports, moves, or deletes older data. If the checkout
contains `.local/app/` or `.local/environment/`, normal startup requires an explicit
storage choice. Preserve those folders; deleting them to bypass the check can lose research.

Compatible existing data can keep its original absolute `stateRoot` values in both
configs. Retain its environment socket and Docker settings, point the app config's
`environmentConfig` to its peer config, and start with
`npm start -- /absolute/path/to/app.json`. Keep that same config for stopping.
Incompatible stored formats are rejected; a location change does not convert them.
This source uses research storage version **5** and Environment storage version **9**.
The new checkpoint and capability contracts require fresh state when upgrading from
earlier experimental formats. Keep the original data and its compatible source build.

Selecting a fresh data directory starts a separate instance. It is not migration.
Moving a bundle can break stored absolute project, Harness, and environment paths.
There is no general automatic relocation or upgrade procedure in this preview.
Keep the original data and matching code until continued use is verified.

## Check attachment storage

Run `npm run verify:storage` to save and reopen a test image and file with the
installed, unmodified Harness. For development, use
`POLARITON_PROFILE=development npm run verify:storage`.

The check creates and removes only its own temporary directory beneath the selected
data root. It makes no model requests and does not change app or environment records.
An empty data root may remain. Harness synchronizes ancestor directories, so a custom
location or restrictive sandbox can still fail even when ordinary file creation works.
