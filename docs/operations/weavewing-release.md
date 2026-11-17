# Release Weavewing

The manual Sparkwing `release` pipeline builds Linux x64 AppImage/deb, Windows
x64 NSIS, macOS arm64 DMG/zip, and the matching CLI archives. Linux and Windows
build here. macOS builds on `ssh moonborn`. Keep that Mac awake and reachable.

Use a clean release worktree with no `.env` or `.env.local`. For draft and
promote, its commit must already be pushed to `origin/main`. Version alignment
happens in an archived source tree, leaving the release checkout unchanged.
The Rust version is pinned in `rust-toolchain.toml`. Install rustup user-locally
on both hosts. Linux also needs a C toolchain, pkg-config, libsecret development
headers, ImageMagick, patchelf and zip. Windows cross-builds install the pinned
`cargo-xwin`, which downloads Microsoft's CRT and Windows SDK.

```bash
sparkwing run release -C <worktree> --detach -- --worktree <worktree> --version 1.0.0 --stage plan
sparkwing run release -C <worktree> --detach -- --worktree <worktree> --version 1.0.0
sparkwing run release -C <worktree> --detach --allow-risk prod -- --worktree <worktree> --version 1.0.0 --stage promote
```

`plan` runs the builds and writes the proposed release without GitHub writes.
`draft` creates or refreshes a private draft called `Weavewing 1.0.0`, targeting
the release commit with tag name `weavewing-v1.0.0`. A draft creates no tag.
`promote` verifies the complete uploaded asset set and every SHA256 checksum,
then publishes the draft as latest. Only promote needs the prod risk grant.

The default platform set is `linux,win,mac`. `--platforms linux,win` rebuilds a
subset for a draft. Windows always builds the Linux CLI archive for its embedded
WSL runtime. Promote requires all three platforms. `--notes-file <absolute-path>`
replaces generated notes. Edit the draft notes before promoting if needed.

Artifacts, checksums, notes, source provenance and command logs live below
`~/evidence/t3code/sparkwing/runs/release/<run id>/`. `--evidence` selects another
absolute directory. Keep the generated `release.json` and `artifacts.json` with
the release evidence. Windows native checks copy the NSIS staging payload to a
new Windows temporary directory and run its native probes and CLI smoke there.
They do not execute NSIS registration because it could replace an existing app.

## Credentials and signing

GitHub operations use the existing `gh` login. The optional Sparkwing secret
`WEAVEWING_RELEASE_GH_TOKEN` takes precedence. Scope it to Contents read/write
on `koreyGambill/weavewing`. Tokens are passed through process environment,
never command arguments or evidence.

All desktop builds ship unsigned. macOS uses ad-hoc signing. Release notes
include the operating system overrides and explain that unsigned mac builds
don't auto-update. Managed policy may block the override.

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
gh release delete weavewing-v1.0.0 --repo koreyGambill/weavewing
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
