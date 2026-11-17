# Install Weavewing test builds

Three ways to put an unreleased build in front of the maintainer. Publishing is
covered in [Release Weavewing](./weavewing-release.md).

| Path                            | Use it for                                                | Approval                                  |
| ------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Local update (Windows/WSL)      | Trying merged `main` on the maintainer's PC               | Tell them first: it restarts their app    |
| Mac build-only                  | Trying a build on the Mac without publishing              | None for the build; installing needs a go |
| Test channel (`--channel test`) | A public pre-release seen only by installs set to Nightly | Required: anything published is public    |

The local install has no update feed baked in, so it never offers itself GitHub
releases. The local updater is its only update path.

## Local update on Windows/WSL

`vp run desktop:update-local` (`scripts/update-local-desktop.ts`) prepares a build ahead of time,
then activates it when the maintainer is ready to restart. Machine-specific install and helper paths
live in the maintainer's private notes. See
[Local Windows candidate staging](./development.md#local-windows-candidate-staging) for flags.

1. Use a clean checkout at the revision to install, usually merged `main`. Invoke the script with
   the repository's pinned Node by full path if `node` on `PATH` is older.
2. Run the normal build command with `--prepare-only` and a new `--output-dir` under
   `~/.local/share/weavewing-builds/<short-sha>`. Preparation builds, smoke-tests and stages a candidate
   without backing up state or changing the running install. It can run after each merge.
   Matching commits and tool inputs reuse verified build artifacts. The latest three prepared outputs
   are retained, together with any activation still in progress.
3. `--plan-only` reports whether the change needs a full shell replacement or the fast web/server path.
   Shared contracts, migrations, dependencies and shell changes force the full path. `--full` forces it.
4. When the maintainer is ready for a restart, run from that same clean revision:

   ```sh
   vp run desktop:update-local --activate /absolute/path/to/prepared-output --notify-thread <thread-id>
   ```

   Activation verifies the original installed receipt, commit, update path and artifact digests.
   If the install or prepared content changed, prepare again. Activation takes fresh backups and uses
   the staged files without rebuilding. `prepare-timing.json` records preparation time and cache reuse.
   `receipt.json` records activation's `durationMilliseconds` for comparison.

5. Activation detaches onto Windows and reports to the named thread after restart. End the turn after
   launching. `detached.stderr` records PowerShell startup errors. The old `--check-only` and `--dry-run`
   flags are removed.
6. Activation proceeds without waiting for turns to finish. The WSL runtime gets
   SIGTERM and five seconds to shut down before a forced stop. Full updates close
   the desktop gracefully; the WSL server sees its launcher exit and shuts down
   on its own.
   With **Continue threads after restarts** enabled (the default), threads
   with saved provider sessions receive a continuation turn after restart.
   Executing tools and provider-native background work do not resume. App-owned
   child tasks recover in their own threads and report back. Interrupted runs
   show a shutdown or restart notice and stop streaming. Scheduled tasks retain
   their schedules, record interrupted invocations as failed, and follow any
   dispatched thread turns through recovery.

**Success:** the notify message says verified, and `<output-dir>/receipt.json`
has `"status": "verified"` with the healthy runtime; `activation.log` sits
beside it.

**Rollback:** automatic when the new runtime is not healthy before the
deadline; the receipt then says `installed: previous`. Backups land beside the
install dir (`.<name>-local-update-rollback`) and under
`~/.local/share/weavewing-update-backups/`.

### Gotchas

- Migrations move the live database forward. An older build cannot open it
  afterwards, so there is no downgrade through this path.
- Large databases can outrun the 240-second health deadline while migrating.
  The update rolls back the app but the database stays migrated; a retry
  verifies.
- Transient WSL interop stalls retry within a bounded deadline. A timed-out health operation gets
  at most three attempts within 90 seconds. The updater refuses to stop an unverified runtime. If all
  attempts fail, ask the maintainer to repair WSL before retrying. Do not restart WSL yourself.
- The resource-monitor helpers must come from a release whose
  `native/resource-monitor` matches `HEAD`. After an upstream merge changes it,
  the check fails with "git exited 1"; refresh the helpers from a matching
  nightly.
- "linked-environment check did not pass … Link deadline expired" is a warning,
  not a failure.

## Mac build without publishing

```sh
sparkwing run release -C <worktree> --detach -- --worktree <worktree> \
  --version 0.x.y --stage plan --build-only --platforms mac
```

A plan run makes no GitHub writes. The DMG lands in the run's `assets/`
directory. The Mac builder must be awake and reachable.

To install it on the Mac:

1. Check the DMG against `SHA256SUMS`.
2. Quit the app by bundle id
   (`osascript -e 'tell application id "dev.weavewing.desktop" to quit'`) and
   wait for its processes to exit.
3. Back up `~/.t3/userdata` and the old app.
4. `hdiutil attach -nobrowse -readonly`, `ditto` the app into `/Applications`,
   detach.
5. `xattr -dr com.apple.quarantine`, `codesign --verify --deep --strict`, then
   `open`.

The first launch after a signature or identity change waits on a Keychain
prompt the maintainer must approve at the Mac; over ssh it looks like a hang.
To smoke-test without touching real data, launch with temporary `HOME` and
`T3CODE_HOME` plus `--use-mock-keychain`.
