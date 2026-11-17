# Release Weavewing

The manual Sparkwing `release` pipeline builds Linux x64 AppImage/deb, Windows
x64 NSIS, macOS arm64 DMG/zip, and the matching CLI archives. Linux and Windows
build here. macOS builds on `ssh moonborn`. Keep that Mac awake and reachable.

Use a clean release worktree with no `.env` or `.env.local`. For draft and
promote, its commit must already be pushed to `origin/main`. Version alignment
happens in an archived source tree, leaving the release checkout unchanged.
The Rust version is pinned in `rust-toolchain.toml`. Install rustup user-locally
on both hosts. Linux also needs a C toolchain, pkg-config, libsecret development
headers, ImageMagick, patchelf and zip. Windows also needs Clang, LLD and LLVM.
Windows cross-builds install the pinned
`cargo-xwin`, which downloads Microsoft's CRT and Windows SDK.

```bash
sparkwing run release -C <worktree> --detach -- --worktree <worktree> --version 0.1.0 --stage plan
sparkwing run release -C <worktree> --detach -- --worktree <worktree> --version 0.1.0
sparkwing run release -C <worktree> --detach --allow-risk prod -- --worktree <worktree> --version 0.1.0 --stage promote --draft-evidence <draft-run-directory>
```

`--channel stable` is the default and requires a plain `0.x.y` version. Stable
releases use `latest*.yml` and publish as the latest normal GitHub release.
`--channel test` requires `0.x.y-nightly.YYYYMMDD.N`, for example
`0.2.0-nightly.20261117.1`. Test builds reuse the desktop Nightly channel and
`nightly*.yml`. Their drafts and promoted releases are prereleases with
`latest=false`. Both channels refuse `1.0.0` and above, including prereleases.

```bash
sparkwing run release -C <worktree> --detach -- --worktree <worktree> --version 0.2.0-nightly.20261117.1 --channel test --stage plan --build-only --platforms linux
```

In desktop **Settings → About → Update track**, choose **Stable** or **Nightly**
(the test channel). Stable installs never see test builds. Nightly installs take
the newest stable or test version. Managed policy can lock this choice.
Automatic checks are off by default. **Check for Updates** and changing the track
are manual checks. Unsigned macOS builds cannot auto-update on either channel.
The release's `release-metadata.json` carries its version and database migration
compatibility for the existing guarded track switch.

`plan` runs the builds and writes the proposed release without GitHub writes.
For artifact proof while CI is unavailable, add `--build-only` to a plan run.
The evidence records CI as skipped. Draft and promote reject this flag, and
promote runs CI at the release commit before publishing.
`draft` creates or refreshes a private draft called `Weavewing 0.1.0`, targeting
the release commit with tag name `weavewing-v0.1.0`. A draft creates no tag.
`promote` verifies the complete uploaded asset set against `assets/SHA256SUMS`
in the draft run's local evidence directory, including its release commit and CI result,
then publishes it with the selected channel’s prerelease and latest flags. Only promote needs the prod risk grant.

The default platform set is `linux,win,mac`. `--platforms linux,win` rebuilds a
subset for a draft. Windows always builds the Linux CLI archive for its embedded
WSL runtime. Promote requires all three platforms. `--notes-file <absolute-path>`
replaces the notes. Draft reruns preserve existing notes unless this flag is given.
Edit the draft notes before promoting if needed. First-release generated notes list
at most 40 first-parent merge subjects since the fork point and link to the full comparison.

Artifacts, checksums, notes, source provenance and command logs live below
`~/evidence/t3code/sparkwing/runs/release/<run id>/`. `--evidence` selects another
absolute directory. Keep the generated `release.json` and `artifacts.json` with
the release evidence, including `assets/SHA256SUMS` and the original assets needed
for promotion. Choose a fresh evidence directory for each run so an old
source archive cannot leave stale files in the build. Windows native checks copy the NSIS staging payload to a
new Windows temporary directory and run its native probes and CLI smoke there.
They do not execute NSIS registration because it could replace an existing app.

## Credentials and signing

GitHub operations use the existing `gh` login. The optional Sparkwing secret
`WEAVEWING_RELEASE_GH_TOKEN` takes precedence. Scope it to Contents read/write
on `koreyGambill/weavewing`. Tokens are passed through process environment,
never command arguments or evidence.

All desktop builds ship unsigned. macOS uses ad-hoc signing. Release notes
include the operating system overrides and explain that unsigned mac builds
don't auto-update on either channel. Managed policy may block the override.

For Apple signing, configure all six optional Sparkwing secrets together:
`APPLE_CSC_LINK` (base64 p12), `APPLE_CSC_KEY_PASSWORD`, `APPLE_API_KEY` (p8 text),
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_TEAM_ID`. The Mac job streams
them over SSH stdin into a temporary keychain and calls the build's signing and
notarytool paths. It removes the keychain and remote build directory afterwards.
Partial signing configuration fails before building. Validate this path with a
plan run before publishing a signed release.

## Rollback

Before promotion, delete the draft and rerun:

```bash
gh release delete weavewing-v0.1.0 --repo koreyGambill/weavewing
```

After promotion, point latest back to the previous good release, delete the bad
release and its tag, then ship a higher patch version:

```bash
gh release edit <previous-tag> --repo koreyGambill/weavewing --latest
gh release delete <bad-tag> --repo koreyGambill/weavewing --cleanup-tag
```

Installs that already updated stay on that build until the fix ships. Turning a
public release back into a draft keeps its tag, so delete it instead. The first
release has no previous release to restore. Remove it and ship a higher version.
