// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderProcesses from "./providerProcesses.ts";
import { classifyScope, make, ownedAgentSlice, type ScopeState } from "./agentScope.ts";

const GiB = 1024 ** 3;
const memory = vi.hoisted(() => ({ total: 16 * 1024 ** 3 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  totalmem: () => memory.total,
}));

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });
});

interface FakeUnit {
  activeState: string;
  result: string;
  controlGroup?: string;
}

const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeUnit>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly failingVerbs: Set<string>;
    readonly stateDir: string;
    readonly cgroupRoot: string;
    readonly setLingering: (lingering: boolean) => void;
  }) => Effect.Effect<A, E, Scope.Scope>,
  // A user manager older than systemd 253 rejects OOMPolicy on scopes.
  {
    oomPolicy = true,
    stopFails = false,
    leftovers = false,
    liveOwner = false,
    slowCleanup = false,
    probeTimesOut = false,
    userManager = "parent",
    username = "tester",
  }: {
    readonly oomPolicy?: boolean;
    readonly stopFails?: boolean;
    readonly leftovers?: boolean;
    readonly liveOwner?: boolean;
    readonly slowCleanup?: boolean;
    readonly probeTimesOut?: boolean;
    /** Whether the user manager outlives the server: it runs the server, or lingering keeps it. */
    readonly userManager?:
      | "parent"
      | "legacy-parent"
      | "other-user-parent"
      | "other-controller-parent"
      | "lingering"
      | "login-bound";
    readonly username?: string | null;
  } = {},
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const cgroupRoot = NodePath.join(bin, "cgroup");
    const ownCgroup = NodePath.join(bin, "self-cgroup");
    const underManager = (uid: number) =>
      `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/t3.scope`;
    NodeFS.writeFileSync(
      ownCgroup,
      {
        parent: `0::${underManager(1000)}\n`,
        "legacy-parent": `2:cpu,cpuacct:/\n1:name=systemd:${underManager(1000)}\n`,
        "other-user-parent": `0::${underManager(1001)}\n`,
        "other-controller-parent": `2:cpu,cpuacct:${underManager(1000)}\n0::/non-systemd\n`,
        lingering: "0::/non-systemd\n",
        "login-bound": "0::/non-systemd\n",
      }[userManager],
    );
    const lingerDir = NodePath.join(bin, "linger");
    NodeFS.mkdirSync(lingerDir);
    const setLingering = (lingering: boolean) => {
      const file = NodePath.join(lingerDir, "tester");
      if (lingering) NodeFS.writeFileSync(file, "");
      else NodeFS.rmSync(file, { force: true });
    };
    setLingering(userManager === "lingering");
    const units = new Map<string, FakeUnit>();
    const calls: Array<ReadonlyArray<string>> = [];
    const failingVerbs = new Set<string>();
    const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(code),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const stopping = yield* Deferred.make<void>();
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args, timeout }) =>
        Effect.sync(() => {
          expect(timeout).toBe(
            args[1] === "stop" && args[2] === ownedAgentSlice(stateDir) ? "2 seconds" : "5 seconds",
          );
          calls.push(args);
          if (!oomPolicy && args.some((arg) => arg.startsWith("--property=OOMPolicy="))) {
            return output("", 1);
          }
          const [, verb, unit = ""] = args;
          if (failingVerbs.has(verb!)) return output("", 1);
          if (stopFails && verb === "stop") {
            return {
              ...output(""),
              stderr: `Failed to stop ${args.at(-1)}: Unit not loaded.`,
              code: ChildProcessSpawner.ExitCode(5),
            };
          }
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n` +
                  `ControlGroup=${state.controlGroup ?? ""}\n`,
          );
        }).pipe(
          Effect.tap(() =>
            slowCleanup && args[1] === "stop"
              ? Deferred.succeed(stopping, undefined).pipe(
                  Effect.andThen(Effect.sleep("10 seconds")),
                )
              : Effect.void,
          ),
          Effect.filterOrFail(
            () => !probeTimesOut || args[1] !== "--scope",
            () =>
              new ProcessRunner.ProcessTimeoutError({
                command: "systemd-run",
                argumentCount: args.length,
                timeoutMs: 2000,
              }),
          ),
        ),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    if (leftovers) {
      NodeFS.mkdirSync(NodePath.join(cgroupRoot, ownedAgentSlice(stateDir)), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(cgroupRoot, ownedAgentSlice(stateDir), "cgroup.events"),
        "populated 1",
      );
      units.set(ownedAgentSlice(stateDir), {
        activeState: "active",
        result: "success",
        controlGroup: `/${ownedAgentSlice(stateDir)}`,
      });
    }
    const constructed = yield* Deferred.make<void>();
    const construction = yield* make.pipe(
      Effect.provideService(ProviderProcesses.ProviderProcesses, { hasOtherLiveOwner: liveOwner }),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
      Effect.provideService(HostProcess.UserId, 1000),
      Effect.provideService(HostProcess.Username, username),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: (path, encoding) =>
          fileSystem.readFileString(
            path === "/proc/self/cgroup" ? ownCgroup : path.replace("/sys/fs/cgroup", cgroupRoot),
            encoding,
          ),
        exists: (path) => fileSystem.exists(path.replace("/var/lib/systemd/linger", lingerDir)),
        writeFileString: (path, data, options) =>
          fileSystem.writeFileString(path.replace("/sys/fs/cgroup", cgroupRoot), data, options),
      }),
      Effect.tap(() => Deferred.succeed(constructed, undefined)),
      Effect.forkScoped,
    );
    if (slowCleanup) {
      yield* Deferred.await(stopping);
      yield* TestClock.adjust("1 second");
      expect(yield* Deferred.isDone(constructed)).toBe(true);
    }
    const scope = yield* Fiber.join(construction);
    return yield* body({
      scope,
      units,
      calls,
      failingVerbs,
      stateDir,
      cgroupRoot,
      setLingering,
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-scope-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const unitOf = (launch: Pick<ChildProcess.StandardCommand, "args">) =>
  launch.args
    .map(String)
    .find((arg) => arg.startsWith("--unit="))
    ?.slice("--unit=".length) ?? "";

const sliceOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";

/** An active scope as systemd and the kernel report it, with the agent itself gone. */
const exitedAgent = (
  units: Map<string, FakeUnit>,
  cgroupRoot: string,
  unit: string,
  { populated, oomKills }: { readonly populated: boolean; readonly oomKills: number | undefined },
) => {
  const controlGroup = `/${unit}`;
  NodeFS.mkdirSync(NodePath.join(cgroupRoot, controlGroup), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(cgroupRoot, controlGroup, "cgroup.events"),
    `populated ${populated ? 1 : 0}\nfrozen 0\n`,
  );
  // An undefined count leaves memory.events unreadable.
  if (oomKills !== undefined) {
    NodeFS.writeFileSync(
      NodePath.join(cgroupRoot, controlGroup, "memory.events"),
      `low 0\nhigh 0\nmax 0\noom ${oomKills}\noom_kill ${oomKills}\noom_group_kill 0\n`,
    );
  }
  units.set(unit, { activeState: "active", result: "success", controlGroup });
};

const stopsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter(([, verb]) => verb === "stop");
const launchCodex = (scope: Effect.Success<typeof make>, threadId: string) =>
  makeCodexAppServerSpawnCommand({ command: "agent", args: ["app-server"], threadId }).pipe(
    Effect.provideService(AgentScope, scope),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.map((command) => {
      assert(ChildProcess.isStandardCommand(command));
      return command;
    }),
  );

describe("AgentScope service", () => {
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps shared Codex scopes running without attributing their OOM to the launch thread",
    () =>
      withFakeSystemd(({ scope, units, calls }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          expect(agent.args).toContain("--property=OOMPolicy=stop");
          units.set(unitOf(agent), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(true);

          const codex = yield* launchCodex(scope, "a");
          expect(codex.args).toContain("--property=OOMPolicy=continue");
          expect(codex.args).not.toContain("--property=OOMPolicy=stop");
          expect(codex.args).toContain("--property=TimeoutStopSec=10s");
          expect(codex.args).toContain("--collect");
          units.set(unitOf(codex), { activeState: "active", result: "success" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          units.set(unitOf(codex), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          expect(
            calls.filter(([, verb, unit]) => verb === "show" && unit === unitOf(codex)),
          ).toEqual([]);
        }),
      ),
  );

  it.effect.each([{ oomPolicy: true }, { oomPolicy: false }])(
    "Force stop kills a thread's own scope but never a shared Codex scope (OOM policy $oomPolicy)",
    ({ oomPolicy }) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
            const codex = yield* launchCodex(scope, "b");
            exitedAgent(units, cgroupRoot, unitOf(codex), { populated: true, oomKills: 0 });

            expect(yield* scope.kill("a")).toBe(true);
            expect(
              NodeFS.readFileSync(NodePath.join(cgroupRoot, unitOf(agent), "cgroup.kill"), "utf8"),
            ).toBe("1");
            expect(yield* scope.kill("b")).toBe(false);
            expect(NodeFS.existsSync(NodePath.join(cgroupRoot, unitOf(codex), "cgroup.kill"))).toBe(
              false,
            );
            expect(calls.filter(([, verb]) => verb === "kill")).toEqual([]);
          }),
        { oomPolicy },
      ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("live")).toBe(true);
      }),
    ),
  );

  it.effect("delegates every agent scope so rootless containers can manage their cgroups", () =>
    withFakeSystemd(({ scope }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const codex = yield* launchCodex(scope, "a");
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        for (const launch of [agent, codex, terminal]) {
          expect(launch.args).toContain("--property=Delegate=yes");
        }
      }),
    ),
  );

  it.effect("caps agent memory and yields CPU, disk, and tasks to the server", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const setProperties = calls.filter(([, verb]) => verb === "set-property");
        expect(setProperties).toEqual([
          [
            "--user",
            "set-property",
            "--runtime",
            "app-t3code-agents.slice",
            expect.stringMatching(/^MemoryHigh=\d+$/),
            expect.stringMatching(/^MemoryMax=\d+$/),
          ],
          [
            "--user",
            "set-property",
            "--runtime",
            "app-t3code.slice",
            "CPUWeight=10",
            "IOWeight=10",
            "TasksMax=25%",
          ],
        ]);
      }),
    ),
  );

  it.effect("follows a live memory change at the next launch", () => {
    memory.total = 16 * GiB;
    return withFakeSystemd(({ scope, calls, failingVerbs }) =>
      Effect.gen(function* () {
        const launch = scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const memoryLimits = () =>
          calls
            .filter(
              ([, verb, , slice]) => verb === "set-property" && slice === "app-t3code-agents.slice",
            )
            .map((args) => args.slice(4));
        yield* launch;
        yield* launch;
        expect(memoryLimits()).toEqual([[`MemoryHigh=${10 * GiB}`, `MemoryMax=${12 * GiB}`]]);

        // A VM balloon or `pct set --memory` grows RAM while the server keeps running.
        memory.total = 22 * GiB;
        failingVerbs.add("set-property");
        yield* launch;
        yield* launch;
        failingVerbs.delete("set-property");
        yield* launch;
        yield* launch;
        const grown = [`MemoryHigh=${16 * GiB}`, `MemoryMax=${18 * GiB}`];
        expect(memoryLimits()).toEqual([
          [`MemoryHigh=${10 * GiB}`, `MemoryMax=${12 * GiB}`],
          grown,
          grown,
          grown,
        ]);
      }),
    );
  });

  it.effect("constructs while cleanup is slow and gates scope creation until it finishes", () =>
    withFakeSystemd(
      ({ scope, calls }) =>
        Effect.gen(function* () {
          const launched = yield* Deferred.make<void>();
          const cleaned = yield* Deferred.make<void>();
          const cleared = yield* Deferred.make<void>();
          const clear = yield* scope
            .clear("new-thread")
            .pipe(Effect.andThen(Deferred.succeed(cleared, undefined)), Effect.forkScoped);
          const launch = yield* scope.wrap({ command: "agent", args: [], name: "t" }).pipe(
            Effect.tap(() => Deferred.succeed(launched, undefined)),
            Effect.forkScoped,
          );
          const cleanup = yield* scope.awaitCleanup.pipe(
            Effect.tap(() => Deferred.succeed(cleaned, undefined)),
            Effect.forkScoped,
          );
          yield* TestClock.adjust("1 second");
          expect(yield* Deferred.isDone(launched)).toBe(false);
          expect(yield* Deferred.isDone(cleaned)).toBe(false);
          expect(yield* Deferred.isDone(cleared)).toBe(false);
          expect(calls.map(([, verb]) => verb)).toEqual(["show", "stop"]);
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(cleanup);
          yield* Fiber.join(clear);
          expect((yield* Fiber.join(launch)).command).toBe("/bin/sh");
        }),
      { leftovers: true, slowCleanup: true },
    ),
  );

  it.effect.each([
    { userManager: "parent", username: "tester", scoped: true },
    { userManager: "legacy-parent", username: "tester", scoped: true },
    { userManager: "lingering", username: "tester", scoped: true },
    { userManager: "login-bound", username: "tester", scoped: false },
    { userManager: "other-user-parent", username: "tester", scoped: false },
    { userManager: "other-controller-parent", username: "tester", scoped: false },
    { userManager: "login-bound", username: null, scoped: false },
  ] as const)(
    "scopes agents only when the user manager outlives the server ($userManager, user $username)",
    ({ userManager, username, scoped }) =>
      withFakeSystemd(
        ({ scope, calls }) =>
          Effect.gen(function* () {
            const command = yield* scope.wrap({ command: "agent", args: [], name: "t" });
            expect(command.unit !== undefined).toBe(scoped);
            expect(calls.some(([, verb]) => verb === "--scope")).toBe(scoped);
          }),
        { userManager, username },
      ),
  );

  it.effect("follows a lingering change at the next launch", () =>
    withFakeSystemd(
      ({ scope, units, setLingering }) =>
        Effect.gen(function* () {
          const launch = () =>
            scope.wrap({ command: "agent", args: [], name: "t", threadId: "thread-1" });
          expect((yield* launch()).unit).toBeUndefined();
          setLingering(true);
          const scoped = (yield* launch()).unit;
          assert(scoped !== undefined);
          units.set(scoped, { activeState: "failed", result: "oom-kill" });
          setLingering(false);
          expect((yield* launch()).unit).toBeUndefined();
          expect(yield* scope.oomKilled("thread-1")).toBe(false);
        }),
      { userManager: "login-bound" },
    ),
  );

  it.effect("does not retry a timed-out capability probe until the server restarts", () =>
    withFakeSystemd(
      ({ scope, calls }) =>
        Effect.gen(function* () {
          for (let launch = 0; launch < 2; launch++) {
            const command = yield* scope.wrap({ command: "agent", args: [], name: "t" });
            expect(command.unit).toBeUndefined();
          }
          expect(calls.filter(([, verb]) => verb === "--scope")).toHaveLength(1);
        }),
      { probeTimesOut: true },
    ),
  );

  it.effect.each([false, true])(
    "stops agents a killed server left before an agent launches (stop fails: %s)",
    (stopFails) =>
      withFakeSystemd(
        ({ scope, calls, stateDir, cgroupRoot }) =>
          Effect.gen(function* () {
            yield* scope.awaitCleanup;
            expect(stopsOf(calls)).toEqual(
              Array.from({ length: stopFails ? 2 : 1 }, () => [
                "--user",
                "stop",
                ownedAgentSlice(stateDir),
              ]),
            );
            if (stopFails)
              expect(
                NodeFS.readFileSync(
                  NodePath.join(cgroupRoot, ownedAgentSlice(stateDir), "cgroup.kill"),
                  "utf8",
                ),
              ).toBe("1");
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
            expect(agent.args).toContain("--property=TimeoutStopSec=10s");
            const terminal = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "terminal",
              survivesRestart: true,
            });
            expect(sliceOf(terminal)).toBe("app-t3code-agents.slice");
            expect(stopsOf(calls)).toHaveLength(stopFails ? 2 : 1);
          }),
        { leftovers: true, stopFails },
      ),
  );

  it.effect("leaves the slice to another live server sharing this home", () =>
    withFakeSystemd(({ calls }) => Effect.sync(() => expect(stopsOf(calls)).toEqual([])), {
      leftovers: true,
      liveOwner: true,
    }),
  );

  it.effect("stops leftover processes only in an active agent scope", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        expect(agent.unit).toBe(unit);

        yield* scope.stop("session-2.scope");
        expect(calls.some((args) => args.includes("session-2.scope"))).toBe(false);
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: false, oomKills: 0 });
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        units.get(unit)!.activeState = "deactivating";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([]);

        units.get(unit)!.activeState = "active";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect.each([true, false])(
    "cleans up an OOM exit without losing its diagnosis (OOMPolicy=%s)",
    (oomPolicy) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            const unit = unitOf(agent);
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: undefined });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toEqual(
              oomPolicy ? [] : [["--user", "stop", "--no-block", unit]],
            );

            // The kernel records the kill before systemd records the OOM result.
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toHaveLength(oomPolicy ? 0 : 2);

            if (oomPolicy) {
              units.set(unit, { activeState: "failed", result: "oom-kill" });
              expect(yield* scope.oomKilled("a")).toBe(true);
              units.delete(unit);
              expect(yield* scope.oomKilled("a")).toBe(true);
            }
          }),
        { oomPolicy },
      ),
  );

  it.effect("reports failed daemon cleanup without failing session teardown", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    return withFakeSystemd(
      ({ scope, units, cgroupRoot }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
          yield* scope.stop(unitOf(agent));
          expect(warnings.flat()).toContain("Could not stop an exited agent's scope");
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      { stopFails: true },
    );
  });

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
      }),
    ),
  );
});
