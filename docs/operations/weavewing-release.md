# Release Weavewing

The manual Sparkwing `release` pipeline builds Linux x64 AppImage/deb, Windows
x64 NSIS, macOS arm64 DMG/zip, and the matching CLI archives. Linux and Windows
build here. macOS builds over SSH on the Mac named by the Sparkwing variable
`WEAVEWING_MAC_HOST`, alongside local source bundling and packaging after
preflight and any required full CI pass. Keep that Mac awake and reachable.
Set the variable once to an SSH host alias or `user@host` with key login, for example
`sparkwing secrets set --secret WEAVEWING_MAC_HOST --variable --value mac-builder`.
Runs that include mac fail before building when it is unset.
Linux and Windows packaging share mutable source assets and run in sequence;
Windows also embeds the Linux CLI archive as its WSL runtime.

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
(the test channel). Stable installs never see test builds. The test channel gets test builds. Switch to **Stable** in **Settings → About**
to return, using the guarded migration check. Managed policy can lock this choice.
Automatic checks are off by default. **Check for Updates** and changing the track
are manual checks. Unsigned macOS builds cannot auto-update on either channel.
The release's `release-metadata.json` carries its version and database migration
compatibility for the existing guarded track switch.

Stable releases require full CI. Test releases (the desktop Nightly channel) use
smoke checks only. Both `plan` and `draft` apply this channel policy.

For stable, a passing result can be reused only for the exact Git tree, Node
version, Sparkwing engine and host platform. The tree includes the CI definition
and dependency lockfiles. Draft can reuse a plan result from another clean
checkout or a commit with the identical tree. Missing or damaged full-CI evidence
runs CI again. Smoke results never qualify for this reuse.

For test, the gate consists of the release builds, clean-bundle checks, and the
existing per-platform CLI and native artifact smoke checks. It skips the full
CI pipeline, including its test suites and typechecks. There is no extra static
check because the release already bundles the server, web and desktop code and
compiles the native helpers. `release.json` records `ci: "smoke: test channel"`
and `ci-result.json` records `full: false` after the selected platform checks pass.
These receipts stay with the release evidence and never enter the full-CI store.

Use `--force-ci` on a test plan or draft to run full CI as well. On either channel,
this flag bypasses passing evidence. A failed forced run invalidates the earlier
full pass. It cannot be combined with `--build-only` or promote.

Full CI receipts live in `~/evidence/t3code/sparkwing/full-ci/`. Each release
retains its CI evidence in `ci-result.json` and `release.json`. These are local
maintainer evidence, not a remote CI attestation. Full CI runs all configured
suites and jobs mapped in `.sparkwing/workflows.json`. Rust tests and native
mobile analysis remain outside that pipeline.

`plan` writes the proposed release without GitHub writes.
For artifact proof while full CI is unavailable, add `--build-only` to a plan run.
The evidence records CI as skipped. Draft and promote reject this flag, and
build-only evidence cannot authorize promotion on either channel.
`draft` creates or refreshes a private draft called `Weavewing 0.1.0`, targeting
the release commit with tag name `weavewing-v0.1.0`. A draft creates no tag.
`promote` verifies the complete uploaded asset set against `assets/SHA256SUMS`
in the draft run's local evidence directory, including its release commit and
channel. Stable requires `ci: "passed"`. Test accepts its smoke-only result or a
full pass. A test draft cannot be promoted as stable. To ship stable, create a
stable draft with full CI for its exact tree. Promotion reuses the draft’s CI
evidence and publishes with the channel’s prerelease and latest flags.
Only promote needs the prod risk grant.

The default platform set is `linux,win,mac`. `--platforms linux,win` rebuilds a
subset for a draft. Windows always builds the Linux CLI archive for its embedded
WSL runtime. Promote requires all three platforms. `--notes-file <absolute-path>`
replaces the notes. Draft reruns preserve existing notes unless this flag is given.
Edit the draft notes before promoting if needed, but leave the section between the
`<!-- weavewing:macos-signing -->` markers to the pipeline. First-release generated notes list
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

Linux and Windows builds ship unsigned. Without Apple secrets, macOS uses
ad-hoc signing, and the release notes include the operating system overrides
and explain that unsigned mac builds don't auto-update on either channel.
Managed policy may block the override.

With all six Apple secrets configured, the Mac job signs the app and the CLI
archive with the Developer ID Application identity and notarizes both. Partial
configuration fails before building. The job streams the secrets over SSH stdin
to the Mac build process, which deletes the `.p12` file once it is imported into
a temporary keychain. It takes the lock `~/weavewing-release/signing.lock` so two
signing builds on the Mac cannot interleave, and adds the keychain to the user
keychain search list for the build. Afterwards, also on failure or on SIGINT,
SIGTERM or SIGHUP, the process restores the previous search list and deletes the
keychain and the App Store Connect key file. If the SSH connection drops during
the build, the controller leaves the run directory alone and says so. The next
run's startup removes a run directory only when its `build.pid` names a process
that has exited, and reports one without a valid marker for you to remove by hand.

If a build reports that the signing lock is held, it names the owner's PID and
start time. Confirm with `ps -p <pid>` on the Mac that no Weavewing build is
running, then clear the lock with the `rm -rf` command the error prints.

The Mac job fails unless all of these pass, and records them under `developerId`
in `mac-proof.json`:

- `spctl --assess` accepts the app with source `Notarized Developer ID`.
- `xcrun stapler validate` finds a stapled ticket on the `.app` inside the DMG.
  The CLI executable cannot carry a stapled ticket, so macOS checks its
  notarization online when it first runs.
- `codesign -dv` shows the hardened runtime flag and a `TeamIdentifier` equal to
  `APPLE_TEAM_ID`, for both the app and the CLI executable in its archive.

Every successful Mac build records the SHA-256 of its DMG, zip and CLI archive
with its signing result in a `mac-signing` directory beside the full CI receipts. Drafts and
promotion look up the signing of the Mac assets they actually carry by those
hashes, so a rerun that reuses the draft's Mac assets keeps their result, and
Mac assets without a matching record stop the run. Each draft run rewrites the
notes section between the `<!-- weavewing:macos-signing -->` markers from that
result and keeps the rest of an edited body. A signed section tells people on an
earlier unsigned build to install this one by hand once, because macOS will not
update an ad-hoc signed app to a differently signed one, and warns that macOS
asks again for permissions it granted the earlier build. Without Mac assets,
the section omits macOS. Draft runs refuse notes, including a `--notes-file`,
with stray or duplicate markers or with signing statements outside the section;
remove that text and rerun. While any Apple secret is configured, promote refuses
a stable draft whose Mac assets are not a recorded Developer ID build, and every
promotion refuses notes without exactly one section matching the assets.

### Set up Apple signing

Each step fills the named Sparkwing secrets. Store every value without a
trailing newline, for example
`printf '%s' "$value" | sparkwing secrets set --secret APPLE_TEAM_ID`, or
`sparkwing secrets set --secret APPLE_API_KEY --file AuthKey_<key id>.p8` for a
file.

1. Enroll in the Apple Developer Program with the account that will own
   Weavewing. The Account Holder performs the certificate and API access steps
   below.
2. `APPLE_TEAM_ID`: in the developer account, open **Membership details** and
   copy the 10-character Team ID.
3. On a Mac, open **Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority** and save the request to disk.
4. In **Certificates, Identifiers & Profiles → Certificates**, add a
   **Developer ID Application** certificate (G2 Sub-CA) from that request.
   Download it and open it to install it in the login keychain.
5. `APPLE_CSC_KEY_PASSWORD` and `APPLE_CSC_LINK`: in Keychain Access, under
   **My Certificates**, export only the
   `Developer ID Application: <name> (<Team ID>)` item, with its private key,
   as a `.p12` file protected by a strong password. That password is
   `APPLE_CSC_KEY_PASSWORD`. Store
   `base64 -i DeveloperID.p12 | tr -d '\n'` as `APPLE_CSC_LINK`, then delete the
   `.p12` file. The build refuses a file that holds more or fewer than one
   Developer ID Application identity, or one from another team.
6. In App Store Connect, open **Users and Access → Integrations → App Store
   Connect API**. If needed, request API access as the Account Holder. Under
   **Team Keys**, generate a key with the **Developer** role.
7. `APPLE_API_ISSUER`: the Issuer ID shown above the key list.
   `APPLE_API_KEY_ID`: the new key's Key ID. `APPLE_API_KEY`: the full text of
   the downloaded `AuthKey_<key id>.p8`. Apple offers that download once.
8. Run a build-only plan that includes mac. Confirm that `mac-proof.json`
   holds an empty `developerId.failures` list and that `notes.md` describes a
   signed macOS build before drafting a signed release.

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

## Fork divergence during upstream merges

Weavewing uses tiles and tabs for workspace surfaces. Keep these upstream features removed during weekly merges:

- Legacy terminal drawer splits and groups, including their sidebar and `terminal.split`, `terminal.splitVertical`, and `terminal.new` commands. Each terminal tab owns one PTY; create neighboring terminals with tiles.
- The legacy right panel and sheet, including their toggle, new-tab, close, and maximize commands. Diff, files, browser, device, and other surfaces belong to tile tabs. The fork's side panel (`ToolSidebar.tsx`) remains separate.
- The narrow-window legacy ChatView fallback. Narrow web and desktop windows use the same tile model; native mobile keeps its own terminal UI.

Saved terminal groups become independent tabs using their existing PTY IDs. Removed keybinding commands are ignored without configuration warnings. The command/default guard in the web keybinding tests prevents an upstream merge from restoring those commands silently.
