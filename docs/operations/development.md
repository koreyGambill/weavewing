# Development

## First checkout

T3 Code uses [Vite+](https://viteplus.dev/guide/). Install its global `vp` command:

```sh
curl -fsSL https://vite.plus | bash
```

On Windows, in PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

`vp` provides the Node version pinned in `package.json` (Node 26), so no separate Node install is
needed. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Forge mirror (optional)

GitHub is the source of truth. [source.tanstack.com/@pingdotgg/t3code](https://source.tanstack.com/@pingdotgg/t3code)
is a two-way synced mirror built for many agents working at once. You never need it to contribute.

```sh
git remote set-url origin https://source.tanstack.com/@pingdotgg/t3code.git
git remote add github https://github.com/pingdotgg/t3code.git
src auth login --web && src auth setup-git
```

With `origin` on the mirror, use `src` (it takes `gh`'s commands and flags) and its `source` agent
skill for PRs, issues, reviews, and CI, and leave GitHub's API alone. Pull requests into `main`
merge on GitHub, so GitHub's required checks and reviews still apply. Numbers can differ between
the two forges; in text that reaches GitHub, use the GitHub number.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

To stop a worktree's dev stack when its thread settles, import the **Dev** action from
`t3.json` in Settings > Projects > Actions and start it through the action menu or its
keybinding. Its `stopOnSettle` option lets T3 stop the terminal and its child processes.
Running `vp run dev` through an agent's own shell tool does not attach it to this lifecycle.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev`. An explicit `--home-dir` wins in both cases.
The first start in a worktree seeds its empty database from a read-only copy of
`~/.t3/userdata/statev2.sqlite` if the source is at most 500 MiB. Larger sources warn
and dev starts with an empty database. `--no-seed` or `T3CODE_DEV_SEED=0` skips seeding.
To copy a larger source, or to refresh a seeded worktree, run `vp run migrate-dev-db` with dev
stopped. It may use substantial disk space before pruning. It rebuilds
`<worktree>/.t3/userdata/statev2.sqlite` from a read-only snapshot of the live database and keeps
recent projects and their stopped threads. It drops scheduled tasks, pending work, auth sessions,
and links to other environments, so the dev server never runs the developer's agents or reaches
their other machines. Raise `--projects` and `--threads-per-project` for more data.
Refresh `statev2.sqlite`, not `state.sqlite`: the server copies the V1 `state.sqlite` only when
`statev2.sqlite` is missing. Bring `secrets` and `settings.json` only when the flow under test
needs them. Copy data in, never symlink it; data flows into the worktree, never back out.
The first start in any checkout also builds the native resource monitor with Cargo when
`native/resource-monitor/target` has no binary. Without Rust, dev starts with a warning
and no process telemetry; install Rust and run `vp run build:resource-monitor`.
Never run a development server against the live `~/.t3/userdata`, open it read-write, or clean it up.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed. `--port`/`T3CODE_PORT` and `--web-port`/`T3CODE_WEB_PORT` pin the
backend and web ports instead; dev refuses to start when a pinned port is in use.

`.xwing-env.yaml` declares the same workflow for Xwing. `xwing app run` pins both ports through
those variables and reports their loopback URLs, and `xwing app install` runs the worktree setup
script. Outside T3's setup action, that script finds the main checkout's env files through Git.

### Replay provider

`vp run dev` registers `Replay (dev)`, a local ACP agent at
[dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts). It plays recorded
ACP transcripts with simulated streaming, so the real adapter, orchestration, and UI run
without a paid model. Each scenario is a model, and each prompt plays the next recorded turn.
Bundled servers, including desktop dev, skip it because they have no agent script.
Dev servers add it back on start, so turn it off in Settings instead of removing it.
To add a scenario, point a `SCENARIOS` entry at a generic ACP replay fixture
(`registry_transcript.ndjson`) or a file in [dev-replay](../../apps/server/scripts/dev-replay).
The agent replays session updates, permission requests, and questions. It drops session setup
and vendor frames, so Grok and fx recordings lose their vendor-only behavior.

### Profiling dev startup

Run `vp run profile:startup` to capture the first 20 seconds of inherited Node processes under
`.t3/startup-profiles/<timestamp>`. Workers that execute the preload get separate profiles.
It starts the normal dev runner and accepts its flags.
Stop it with Ctrl+C after the capture. Set `T3CODE_STARTUP_PROFILE_DIR` to choose another output
directory. Profiling adds overhead, so compare readiness with an ordinary `vp run dev` run.

Open a `.cpuprofile` in Chrome DevTools' Performance panel for sampled function stacks and source
lines. Each `.modules.json` is a Chrome trace containing timed module resolution, loading,
synchronous subprocess calls, and startup measures. Per-file records include importer URLs,
source loading, preparation, recursive dependency linking, and top-level evaluation. Preparation
uses synchronous loader boundaries; linking includes dependencies, and CommonJS evaluation can
include nested `require` calls. Some ESM/CommonJS interop reports a combined stage. `.process.json` records the process, Node version, and capture window.
The server's nested Effect and SQL spans remain in `.t3/userdata/logs/server.trace.ndjson`.

The preload temporarily adds module-body timing markers and uses one automatic debugger pause
to instrument the live Node loader. The launcher adds `--no-node-snapshot` to inherited
`NODE_OPTIONS` because Node 26's snapshotted loader cannot accept that breakpoint. Include the
same flag when using the preload directly. This disables Node's built-in startup snapshot,
can change compilation-cache hits, and adds overhead.
Treat per-file captures as diagnostic runs; use uninstrumented runs for baseline startup latency.
The first entry module can compile before loader instrumentation is installed.

A fresh process still uses filesystem, Node compilation, provider, and Vite dependency caches.
Measure a missing Vite dependency cache separately from a restart with an existing database.
Neither the Vite ready message nor the HTTP listener proves that a browser has rendered the app.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

An agent sharing dev runs `vp run dev --share` in the background, waits for the `pairingUrl:` line,
and hands that full URL to an unpaired browser. It does not wire up `tailscale serve` by hand, open
the URL itself, or consume the user's pairing link. A browser holding the reusable dev cookie can
use the bare origin. If a one-time token was consumed, mint a fresh one with
`node apps/server/src/bin.ts pair`; it carries the same scopes as the startup URL.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. These traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.
- The app and its routes are lazy chunks, built on first request. A plugin pre-bundles the
  startup chain when the server starts. Renaming or moving a startup route or the app entry
  silently drops it from that list.
- Bundled dev and `--built` hand Rolldown its own watcher, which skips Vite's default
  `node_modules` ignore. Those files are pnpm-store hardlinks, so another worktree's install or
  removal rebuilds every long-running server and leaks memory. Keep `node_modules` excluded.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts),
[Tailwind plugin](../../apps/web/vite/tailwind.ts), and
[startup warmup](../../apps/web/vite/warmBundledDev.ts).

`vp run dev --share --built` skips the Vite dev server. It runs `vp build --watch` for the web
app, and the backend serves `apps/web/dist` on the same tailnet URL and pairing flow. Use it when
someone tests over a slow link or only needs to use the app: loads are production size, and the
first load does not wait for dev bundling. There is no HMR. After an edit, wait for the
`built in` line (about 6 s), then reload. Until the first build exists, the URL shows a page that
reloads by itself. The license manifest is not generated in this mode. `--built` requires
`--share` and the `dev` mode.

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Checks

`vp run check:changed` runs CI's fast checks for your branch's changes: format and lint of the
changed files, `knip:check` when code or a manifest changes, the generated GraphQL checks, typecheck
of the affected packages and their dependents, and the test files beside the changed files. It also
runs the checks that read other files: the agent context budget when the server is affected, and
React Compiler coverage for only the changed web and mobile files. It maps
files to packages with [ci-changes.cjs](../../.github/scripts/ci-changes.cjs), as CI does. It
compares against the closest merge base with any remote's `main`, so a fork whose `main` lags
upstream still compares against upstream, or with a ref you pass. CI still runs the full
test suites and the jobs the summary lists, so a local pass does not promise a green CI run.

The steps run side by side, as many at once as the machine allows: one per two cores and per 6 GiB
of available memory. On a large machine a run takes about as long as its slowest step, usually
knip's exports pass at about 10 s. Pass `--concurrency <n>` or set `CHECK_CHANGED_CONCURRENCY` to
change the limit (`1` runs the steps one by one). A step that runs past `--timeout <seconds>` or
`CHECK_CHANGED_TIMEOUT` (default 900) is killed with every process it started and reported as
`TIMEOUT`, not as a failing check. When the files are exactly those of the last passing run, it prints that
run's summary instead of running again. Any change to a file, the install, or a generated file runs
the checks again.

While you iterate, run single checks:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

In `apps/web`, a test that renders React or touches the DOM is named `*.browser.test.{ts,tsx}`
and runs in headless Chromium with the React Compiler on, like the app. There is no jsdom; other
`*.test.ts` files run in Node.

TypeScript workspaces typecheck with `effect-tsgo tsrs --noEmit` from `@effect/tsgo`: the
[tsrs](https://github.com/oxc-project/tsrs) checker with Effect diagnostics, quick fixes, and
refactors built in. Only `apps/marketing` installs `typescript`, for Astro. VS Code's TypeScript 7
extension starts the same checker through `.vscode/tsdk/tsgo` (`js/ts.tsdk.path`), a POSIX
script, so on Windows open the workspace through WSL.

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo and, at the same time,
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

`dist:desktop:linux` targets x64. For a native Linux ARM64 build, run:

```sh
vp run dist:desktop:artifact --platform linux --target AppImage --arch arm64
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Prepared server bytecode

Native macOS and Windows desktop artifact builds, and native Linux x64 and ARM64 builds, generate server
bytecode with the packaged Electron executable, after ASAR creation and before signing. Generation imports the CLI and server
module declarations without launching server services; worker-only modules compile normally.
AppImage backends use temporary links for each mount and remove them on normal exit. Later launches
reclaim abandoned cache directories whose links point to gone mounts; AppImage main-process caching
stays disabled. macOS x64 builds on ARM64 hosts run the packaged x64 Electron
under Rosetta to generate the cache. Other cross-platform and cross-architecture builds skip
generation explicitly. CLI, SEA and WSL runtimes keep their existing behavior.

Electron's Node 24 cache has no read-only option and includes the producer UID in its directory
name. The backend links individual prepared files into its writable cache with keys for the
installed module paths. Node replaces files atomically, so regeneration cannot write through those
links into signed resources. Windows uses hard links and falls back to normal caching when volumes
differ or resource permissions prevent linking. Protected installations therefore may not reuse
prepared bytecode. No cache bytes are copied during startup.

The key calculation follows Node's internal portable ESM format. Generation checks that the
packaged engine produced the expected CLI and server entries and fails the build if that format changes.
The manifest also checks Electron, Node, OS, architecture and V8's flags-sensitive version tag.
Missing or rejected entries compile from the shipped JavaScript. Prepared backends skip the
explicit startup flush; Node can persist missing entries on normal exit. The writable fallback
keeps the explicit flush needed when Windows force-kills the backend.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.
Bytecode preparation also runs packaged Electron and requires GTK, NSS, ALSA, and GBM runtime libraries.
Install Rust 1.95 or newer through [rustup](https://rust-lang.org/install), using the stable
toolchain as release CI does.
The packaged ELF compatibility check uses binutils’ `readelf`, included by the C/C++ toolchain.

Ubuntu 24.04 and Debian 13:

```sh
sudo apt-get update
sudo apt-get install build-essential libsecret-1-dev pkg-config imagemagick libgtk-3-0t64 libnss3 libasound2t64 libgbm1
```

On Ubuntu 22.04 and Debian 12, use `libgtk-3-0` and `libasound2` instead of the `t64` packages.

Fedora:

```sh
sudo dnf install gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick gtk3 nss alsa-lib mesa-libgbm
```

Arch Linux:

```sh
sudo pacman -S base-devel libsecret pkgconf imagemagick gtk3 nss alsa-lib mesa
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.

### Local Windows candidate staging

From a clean WSL checkout, build, verify and stage a local Weavewing update:

```sh
vp run desktop:update-local \
  --install-dir 'C:\Users\you\Apps\Weavewing' \
  --output-dir /absolute/path/to/update-evidence \
  --vp-home /absolute/path/to/vite-plus \
  --patchelf-dir /absolute/path/to/patchelf/bin \
  --linux-monitor-dir /absolute/path/to/linux/resource-monitor \
  --windows-monitor /absolute/path/to/t3-resource-monitor.exe \
  --prepare-only
```

Use the repository's pinned Node version and a Vite Plus home containing `current/bin/vp`.
The driver creates private shims, so archived homes with broken `bin` links work. `VP_HOME` can supply
`--vp-home`; `patchelf` can come from PATH. Both resource monitors come from one release. The Linux
monitor directory holds a `source-tag` file naming that tag, and `native/resource-monitor` must be
unchanged since it. The command targets Windows/WSL x64.

The installed receipt selects the update path. Missing provenance, shell or dependency changes,
shared packages, and migrations require a full update. `--full` forces that path. One full update
installs a shell that can serve loose `resources/client` assets; older shells cannot use the fast path.
After that, web/server-only changes build the Linux runtime and client, overlay the new client files
on the installed `resources/client` (old hashed chunks stay so an open page keeps working) and restart
the WSL runtime without restarting Electron. The desktop serves that directory only while its `.shell-version`
marker matches the running shell version. The desktop must already be running. Press Ctrl+Shift+R in
Weavewing to load the new UI; the receipt records `reloadPending` and the notification says so.
The next full update drops stale chunks. `--wsl-only` requests this path, but refuses shared wire or
any migration-named change and shells without loose-client support. The Windows primary server keeps
its previous code until the next full update. Receipts record shell and client commits separately.
Use `--plan-only --installed-receipt /absolute/path/to/receipt.json` to inspect selection without a build.

`--prepare-only` builds, smoke-tests and stages everything needed for activation. It leaves the
installed app and runtime selection running and takes no state backups. Full updates stage a unique
marked Windows sibling slot and probe its native modules. Use a new absolute output directory for each
preparation, preferably under `~/.local/share/weavewing-builds/`.

When ready to restart, run from the same clean source revision:

```sh
vp run desktop:update-local --activate /absolute/path/to/prepared-output --notify-thread <thread-id>
```

Activation verifies `prepared.json`, including the commit, selected update path, installed receipt and
shell/runtime hashes, configuration, client tree and staged payload. Missing or changed content refuses
activation before shutdown. If the install changed since preparation, prepare again.
Activation installs the prepared Linux runtime, backs up state, then stops, swaps, restarts and
health-checks. Preparation compares the installed runtime receipt's `commit` with the candidate's
migration files, registry and startup migration helpers, plus the resolved Effect version. Activation
reads the live database's recorded migrations read-only and verifies the receipt's runtime digest.
The candidate registry explicitly classifies every migration as destructive or additive. Activation
copies the large WSL `statev2.sqlite` only when a candidate migration missing from the live ledger
is destructive, or when migration history, classification or runtime provenance cannot be verified.
Additive migrations preserve data and schema the previous build needs. Drops, renames, incompatible
types and rewrites of existing data require a destructive classification. Older unreviewed migrations
are classified conservatively. Changed historical migrations, startup helpers or the migration engine
also require a copy. Skipping it records `additive-migrations-only` (or `migration-set-unchanged`)
and leaves no manual-recovery database snapshot. Older builds tolerate unknown newer migration IDs
and warn about them. Rollback then reuses the migrated database.
Small state files, including settings, keybindings, secrets, environment identity and thread workspaces,
are always backed up. Windows state still gets a complete backup on full updates. Activation does no
build or archive smoke test. The Windows activation detaches so the calling thread can survive the
restart. End the turn after launching it. Omitting `--prepare-only` prepares and then activates in
one invocation. The old `--check-only` and `--dry-run` flags are removed.

Preparation reuses verified build artifacts when the source commit, update path, Node/Vite Plus and
resource-monitor inputs, lockfile, dependency installation and local env files match. Builds inherit only
execution-related environment variables and suppress baked HTTP/WebSocket origins. Preparation still
smoke-tests the archive and stages a separate candidate. Windows interop launch errors get up to
three attempts. A staging timeout stops preparation because its Windows process may still be running;
only idempotent probes retry timeouts. Candidate cleanup retries launch errors only.
The managed builds directory keeps the latest three completed builds or prepared outputs. Active
preparations and claimed activations are retained while their recorded PID and start time match a live
owner. Stale markers are reported and removed. A failed Windows staging attempt keeps its verified
build cache, so a fresh preparation can retry staging without rebuilding.
Pruning removes their owned Windows slots and saves logs, manifests and timings under
`~/evidence/t3code/prepared-installs/`. Unmarked older output directories are left alone.
`prepare-timing.json` records preparation time and cache reuse. The activation receipt records
`durationMilliseconds`, covering validation, fresh backups and restart. It also records
`timeToCloseDesktopMilliseconds` from activation start until the desktop exits,
`desktopCloseMilliseconds` for graceful closure itself, and `desktopDowntimeMilliseconds` from the
close request until a healthy runtime answers. Runtime-only updates record zero desktop downtime
unless recovery has to close the desktop. `wslBackup.databaseBackup` records whether the database copy
ran and why.
An automatic app rollback without that copy restarts the previous build on the same database.
Activation writes fresh backup paths and peer-link baselines outside the sealed configuration. A
failure before shutdown leaves the prepared output available for another activation attempt.

Activation proceeds without waiting for active turns. `--wsl-distro` defaults to `WSL_DISTRO_NAME`
and `--wsl-home` to `~/.t3`. The install must have a healthy runtime and `Start Weavewing.cmd`.

The fast path sends SIGTERM to the verified WSL runtime and allows five seconds for shutdown,
then uses SIGKILL if that same process remains. The receipt records `runtimeStop.forced`.
Full updates close the desktop gracefully. The WSL server notices its launcher exit and shuts down
without a deadline.
The server saves restart continuation requests before stopping providers and reconciles unfinished runs.
On startup it also recovers runs left by a forced exit. The old run is cancelled, streaming indicators
stop, and the thread shows a shutdown or restart notice. With **Continue threads after restarts**
enabled (the default, with per-project overrides), eligible threads receive a continuation turn using
saved provider history. This requires a saved native session the provider can reopen. It does not
resume an executing tool call. Provider background commands and native subagents are cancelled.
App-owned delegated tasks retain their child threads and deliver results after recovery.
Scheduled tasks retain their schedules and recover dispatched run history. An interrupted scheduled
run can continue as a thread turn, while the schedule records the interrupted invocation as failed.

Both paths back up small WSL state files; full updates also snapshot Windows state. When the
database copy is required, they snapshot `statev2.sqlite` with SQLite's backup API in one step on a
read-only connection, then copy settings, secrets and thread workspaces. WAL writers can continue
during the snapshot. Each snapshot helper has a four-minute deadline and removes partial output on
failure. It excludes `server-owner.sqlite`, the live ownership lock. Activation keeps the WSL snapshot
on the Linux disk under `~/.local/share/weavewing-update-backups/<commit>-<attempt>` (writing it through
`/mnt/c` is too slow) and retains the Windows snapshot in the rollback directory. Each keeps only the
latest update's copy.
Keep logs and receipts separate from private state.
It carries over the install's launchers, closes the main window gracefully, waits for the WSL server
to exit, swaps the app and relaunches `Weavewing.exe` with the `set "NAME=VALUE"` variables from
`Start Weavewing.cmd`, writing its output to `%TEMP%\weavewing-desktop-<install-name>.stdout`/`.stderr`.
Preflight refuses a launcher with any other line except `@echo off`, `setlocal` and its `start` line.
A desktop that exits before its runtime is healthy fails activation at once, unless it exited cleanly
and handed off to a running Weavewing window; the receipt's
`desktopLaunches` keeps its exit code and output. Health checks require the process
under the new archive digest to answer the environment endpoint with the original environment id.
`--health-seconds` defaults to 240; the non-migrating fast path caps it at 45 seconds. Transient probe
failures remain in the receipt while health polling continues to its deadline.
Every WSL call first runs `/bin/true` with a 3-second limit. A health operation that times out
retries up to three times within one 90-second total budget. Post-restart health probes share the
remaining health deadline instead. A deterministic failure refuses at once. A fragmented WSL kernel
can fail the hvsock channel each `wsl.exe` launch needs (`page allocation failure: order:7` in `dmesg`),
so launches
can hang for minutes while some still pass. Failed probes retry with backoff, logged as
`wsl-responsive-retry`, and the updater refuses runtime operations only when nothing answers for 5 minutes;
a missing distro or binary refuses at once. Waiting for the old WSL server shares one
5-minute budget, so the closed desktop stays down at most about 6.5 minutes before relaunch.
Failure restores and relaunches the previous app. If the previous app cannot be moved back, the candidate is
relaunched instead; the receipt's `installed` (`previous`, `candidate` or `none`) and the notification say
what is installed. The receipt
reads `recovering` during every recovery. State snapshots
are retained for manual recovery; rollback does not overwrite live user data or undo database migrations.
After a healthy full swap, a separate deadline of at most 20 seconds covers both existing Windows/WSL peer
identities at their saved URLs and a read-only authenticated MCP call from each side. The probes read
existing peer credentials locally. They never rotate credentials or re-link environments. A failed
link check appears as a warning in the receipt and notification, because it can reflect peer startup
or connectivity while the updated app is healthy. It does not trigger rollback.

Staging requires payload bytes plus 20 GiB free; this local reserve does not guarantee packaging space or
govern other activity. Preparation uses its own marked sibling `.<install-name>-prepared-<id>` slot.
Space or copy failure preserves the previous payload. Private state, evidence, unowned slots,
and running candidates are refused. Activation keeps one marked `.<install-name>-local-update-rollback`
directory containing the previous app and state snapshots, replacing only its own older rollback.
Check `receipt.json` and `activation.log` in the output directory after restart. Every PowerShell mode
records exceptions as `failed` with an error message, including setup failures. The detached driver's
output also points to `detached.stderr` for startup diagnostics.
The receipt links `helpers/`, which records every helper PID at spawn.
`--notify-thread ID` additionally sends the result and any error with `t3 thread send`, which queues
behind a running turn; the receipt's `notification` records whether it was sent.

The staging helper remains available as `scripts/stage-windows-desktop.ps1`. Run its adjacent fixture
test and `scripts/activate-local-desktop.test.ps1 -WorkerPath <output-directory>\worker.mjs`
in Windows PowerShell with a Windows `node.exe` to check staging, early failure receipts, bounded
link results, rollback and backup behavior.
