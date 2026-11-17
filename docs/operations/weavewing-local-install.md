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

`vp run desktop:update-local` (`scripts/update-local-desktop.ts`) builds the
checkout's `HEAD`, backs up state, installs, restarts and health-checks the app,
and rolls back on failure. Flags are in
[Local Windows candidate staging](./development.md#local-windows-candidate-staging)
and `--help`. Machine-specific paths (install dir, helper binaries) live in the
maintainer's private notes, not here.

1. Run from a clean checkout whose `HEAD` is what you want installed, usually
   `main` after a merge. A dirty tree is refused.
2. Call the script with the repository's pinned Node by full path. The `node` on
   `PATH` may be older and fail the engine check.
3. `--plan-only` reports whether it will take the fast web/server-only path or a
   full update, without building. Contract, shell or migration changes force the
   full path; `--full` forces it.
4. `--output-dir` must be a new absolute directory that does not exist yet. Use
   one per run, such as `<builds>/<short-sha>`, and `<short-sha>-b` for a retry.
5. The update restarts the app the calling agent's own thread runs in. Launch it
   detached (`setsid nohup … &`, output to a log) with
   `--notify-thread <thread id>`, which posts "verified" or "failed, previous
   restored" back to that thread after the restart. End your turn after
   launching.
6. `--drain-minutes N` waits for active turns (default 5); `0` skips the wait.
   Any turn still running is cut off by the restart, including the launching
   thread's. Pick a quiet moment.

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
- WSL interop stalls (`accept4 failed 110`, `wsl-responsive exceeded 3s`) fail
  activation and roll back. Ask the maintainer to run `wsl --shutdown`, then
  retry. Do not restart WSL yourself: it kills every agent on the machine.
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
