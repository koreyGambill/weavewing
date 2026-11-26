# Weavewing

Weavewing is a public fork of T3 Code, a GUI for coding agents. The repository is public, so keep personal data, hostnames and credentials out of everything you commit. A Node WebSocket server wraps provider CLIs and serves web, desktop (Electron), and mobile (React Native) clients. Terms such as environment, project, thread and turn: [glossary](docs/internals/glossary.md). You are probably running inside the developer's own T3 Code instance, so a careless kill or write can take down the app driving you.

## Hazards

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and other dev servers run here. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real database, in use while you work. Reading and copying from it are fine. Never start a server against it, open it read-write, or clean it up. Copy data into your worktree, never symlink.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`; setting them bakes localhost into the bundle and breaks every remote browser.
4. **Detached servers.** Run dev servers, Metro, and builds from your own shell so they end with your session. Use `systemd-run`, `nohup`, `setsid`, or `tmux` only when the user asks for a server that outlives the session; detached servers once ran for weeks and filled RAM and swap.

## Dev servers

- `vp i` installs. Worktree setup runs it in the background: while `.t3/setup-running` names a live PID, wait instead of running `vp i`. Setup ends with `.t3/setup-done` or `.t3/setup-failed` (with the error tail). With no marker, setup never ran, so run `vp i` yourself.
- `vp run dev` starts server and web. In a worktree, state lives in the worktree's gitignored `.t3`, even when `T3CODE_HOME` is set; an explicit `--home-dir` wins. The first start tries to seed that database from a read-only copy of real data, and skips seeding when the source is over 500 MiB or `--no-seed` is set, so an empty database is not a bug; `vp run migrate-dev-db` refreshes it with dev stopped.
- Read the real ports from the `[dev-runner]` line; occupied ports shift the path-derived defaults.
- Stop what you started with your harness's own background-task stop, which ends the whole tree. `vp` does not forward SIGTERM, so signalling the `vp run dev` PID alone leaves Vite and the server running.
- Read the [development runbook](docs/operations/development.md) before seeding test data, sharing dev over the tailnet (`--share`), or setting up the reusable dev credential.

## Verifying

- A landing is gated by `vp run check:changed` (format, lint, knip, typecheck, and the tests near the changed files), focused tests with `vp test run <files>` (add `-t "<name>"` for big files), and review. Full suites do not gate a landing, so do not run one before landing. A fix for a broken default branch or gate may land on its focused proof alone, with the review following.
- A test-channel (nightly) release is gated by the release pipeline's own preflight tests and smoke checks: the release builds, the clean-bundle check, and the per-platform CLI and native artifact smoke checks. It runs full CI only when `--force-ci` is passed.
- A stable release is gated by the full Sparkwing `ci` pipeline, which the release pipeline runs itself or accepts from a matching receipt. See [Weavewing release](docs/operations/weavewing-release.md). When someone does need one full suite, run it through admission, never as bare commands in parallel: `sparkwing run suite -C <checkout> -- --worktree <checkout> --suite web`, with `server` or `packages` for the others.
- While iterating, run focused tests and `vp run typecheck`. The checker is `effect-tsgo`; there is no `typescript` package to run.
- Never run repo-wide checks (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked; CI owns the full suite.
- Run `node -e` snippets from `apps/server` or the owning package; `effect` does not resolve from the repo root.
- Before writing or reviewing a test, read [Testing](docs/internals/testing.md): what to test, bug-fix proof, and the browser-test pattern. Server side effects run after the command commits, so tests drain `OrchestrationEffectWorkerV2` or await the persisted event, never sleep or poll; lint enforces this.
- User-visible changes get one integrated pass in the real client: the `test-t3-app` skill for web, `test-t3-mobile` for mobile. The lead does this once after integrating; subagents launch no dev servers of their own.
- Real agent turns cost money: watch turns with the free `Replay (dev)` provider, and use a real provider's cheapest model only when the change depends on it.
- Installing a test build on the maintainer's machines restarts the running app, so ask first: [Install Weavewing test builds](docs/operations/weavewing-local-install.md).
- Before changing model-facing text (agent instructions, MCP tool descriptions, generated titles), read [evals/README.md](evals/README.md) and run the evals it names. A model-behavior fix adds an eval case that fails before it.

## Hit every surface

The commonest defect is a change that works on the tested path and is missing elsewhere. Before calling frontend work done, say which of these applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding.
- **Clients.** Web (local `t3` and hosted), desktop (adds Electron shell and IPC), and mobile (separate navigation). Shared client logic lives in `packages/client-runtime`.
- **Providers.** Each provider has an adapter. A provider-shaped feature needs a decision per adapter, even "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That works only when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`.
- **Reverse states.** A way in needs a way out and a way to see it: snooze needs unsnooze, close needs reopen.
- **Connection modes.** Local, remote/relay, and tunnel behave differently; multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance wrong. Follow the [documentation rules](docs/README.md#documentation-rules) before adding any.

## How it works

Clients send typed WebSocket requests that the server turns into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without I/O. The _event sink_ commits events, the _projections_ the UI reads, the _command receipt_, and _outbox_ effects in one transaction. The _effect worker_ then runs effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs run as subprocesses; per-provider _adapters_ translate their protocols into orchestration events. Each turn ends with a _checkpoint_, a hidden git ref used for diff and restore. More: [overview](docs/internals/overview.md).

## Where code lives

- `apps/server`: WebSocket, orchestration, providers, checkpointing. Read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect/LLMS.md` for the Effect library.
- `apps/web`: React/Vite UI. `apps/desktop` wraps it; `apps/mobile` is React Native; `apps/marketing` is the site.
- `packages/contracts`: Effect/Schema contracts and small derived helpers, no heavy runtime logic.
- `packages/shared`: shared runtime utilities through subpath exports, no barrel.
- `.repos/`: vendored read-only references whose patterns you follow; never edit or import from them. `vpr sync:repos` syncs them after a dependency bump.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure; UI stays dumb.
- Server features are services and transports stay thin: a `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES` in contracts, gate UI on the command's `permissionAtom`, keep raw RPC clients inside `rpc/`, and extend the permission behavior tests. The server stays authoritative: grants are checked at execution against the destination environment.
- `apps/web/src/components/ui` exports own their look: pick a `variant` or `size` and put layout classes on the parent. See [Web UI](docs/internals/web-ui.md).
- React effects synchronize with something outside React; derive in render and act in handlers instead of syncing state, but never hide real lifecycle work in refs or stores to dodge an effect.
- Prefer inferred types over annotations, and never `any`.
- Users notice a dropped frame, a lying spinner, or a stale label. Avoid continuously repainting animations (they peg the GPU) and oversized WebSocket payloads.
- `t3code/*` and `shadcn/*` lint rules enforce comments, UI restyling, effect reasons, the `Effect.fn` function pattern, and test waits; their messages say the fix. Span names and `Effect.fnUntraced` choices are in [Effect services](docs/internals/effect-services.md).
- If a rule here fights the task, say so and get the maintainer's sign-off before breaking it.
