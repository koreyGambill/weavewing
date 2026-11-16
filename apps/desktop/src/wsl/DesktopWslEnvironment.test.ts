// @effect-diagnostics nodeBuiltinImport:off - the executed suite runs the generated install script through a real POSIX shell.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterAll, expect } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";

import { ManagedPolicyFileError } from "@t3tools/shared/managedPolicyFile";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import {
  DesktopWslEnvironment,
  layer as layerDesktopWslEnvironment,
  buildWslRuntimeInstallScript,
  makeIsAvailable,
  buildWslRuntimeInvalidateScript,
  buildWslRuntimePruneScript,
  buildWslRuntimeProbeScript,
  parseResolvedPath,
  parseWslRuntimeRoot,
  windowsToWslPathImpl,
} from "./DesktopWslEnvironment.ts";

// The install script only fails the way this file cares about when a real shell
// runs it, so find one that has the tools it needs: bash directly on Linux, and
// the WSL distro on a Windows dev box, where Git Bash ships no flock. Anywhere
// else the executed suite skips and the generated-text assertions stand alone.
const REQUIRED_SHELL_TOOLS = ["flock", "sha256sum", "tar", "mktemp"] as const;

const posixShellRunner = (() => {
  const candidates = [
    { file: "bash", args: [] as ReadonlyArray<string> },
    { file: "wsl.exe", args: ["-e", "bash"] as ReadonlyArray<string> },
  ];
  const probe = [
    "[ -d /proc/1 ] || exit 1",
    ...REQUIRED_SHELL_TOOLS.map((tool) => `command -v ${tool} >/dev/null || exit 1`),
  ].join("\n");
  return (
    candidates.find((candidate) => {
      const result = NodeChildProcess.spawnSync(candidate.file, [...candidate.args, "-c", probe], {
        encoding: "utf8",
      });
      return result.status === 0;
    }) ?? null
  );
})();

const runShell = (script: string) => {
  if (posixShellRunner === null) throw new Error("no POSIX shell runner available");
  // Pass the script on stdin, as production does, to avoid matching its own /proc scan.
  const result = NodeChildProcess.spawnSync(
    posixShellRunner.file,
    [...posixShellRunner.args, "-s"],
    { input: script, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const sh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const awaitHolder = (condition: string) =>
  `i=0; until ${condition}; do i=$((i + 1)); [ "$i" -lt 500 ] || exit 1; sleep 0.01; done`;

// Use runtime-entry argv[0] for /proc detection; an open pipe keeps it alive only while this script runs.
const holdRuntimeBusy = (entry: string) =>
  [
    `exec 7> >(exec -a ${entry} cat >/dev/null 2>&1)`,
    awaitHolder(`grep -qF -- ${entry} /proc/[0-9]*/cmdline 2>/dev/null`),
  ].join("\n");

const holdInstallLock = (lock: string) =>
  [
    `exec 6> >(exec 9> ${lock}; flock -x 9; cat >/dev/null 2>&1)`,
    awaitHolder(`! flock -n ${lock} true`),
  ].join("\n");

const readField = (stdout: string, field: string) => {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(`${field}:`));
  if (line === undefined) throw new Error(`missing ${field} in fixture output: ${stdout}`);
  return line.slice(field.length + 1).trim();
};

const SERVER_ENTRY_SOURCE = '#!/bin/sh\necho "t3code wsl runtime test server 0.0.0"\n';

describe("WSL runtime cache", () => {
  it.each([
    [
      "install",
      (id: string) => buildWslRuntimeInstallScript("/runtime.tar.gz", id, "b".repeat(64)),
    ],
    ["prune", buildWslRuntimePruneScript],
    ["invalidate", buildWslRuntimeInvalidateScript],
  ] as const)("sanitizes cache ids in the %s script", (_, buildScript) => {
    const runtimeId = "1.2.3/x64; touch /tmp/nope";
    const script = buildScript(runtimeId);
    expect(script).toContain("/1.2.3_x64__touch__tmp_nope");
    expect(script).not.toContain(runtimeId);
  });
});

describe.skipIf(posixShellRunner === null)("WSL runtime install script (executed)", () => {
  const fixtures: Array<string> = [];

  afterAll(() => {
    for (const work of fixtures) runShell(`set -eu\nrm -rf ${sh(work)}`);
    fixtures.length = 0;
  });

  const createFixture = (serverEntry = SERVER_ENTRY_SOURCE) => {
    const result = runShell(
      [
        "set -eu",
        "work=$(mktemp -d)",
        'stage="$work/stage/t3-0.0.0-linux-x64"',
        'mkdir -p "$stage/node_modules/node-pty/build/Release" "$work/home"',
        `printf '%s' ${sh(serverEntry)} > "$stage/t3"`,
        'chmod +x "$stage/t3"',
        `printf '%s' 'pty-native-payload' > "$stage/node_modules/node-pty/build/Release/pty.node"`,
        `tar -czf "$work/wsl-runtime.tar.gz" -C "$work/stage" t3-0.0.0-linux-x64`,
        `printf 'work:%s\\n' "$work"`,
        `printf 'archiveSha:%s\\n' "$(sha256sum "$work/wsl-runtime.tar.gz" | cut -d ' ' -f 1)"`,
      ].join("\n"),
    );
    expect(result.status, result.stderr).toBe(0);

    const work = readField(result.stdout, "work");
    fixtures.push(work);
    const archivePath = `${work}/wsl-runtime.tar.gz`;
    const archiveSha = readField(result.stdout, "archiveSha");
    const runtimeId = `sha256-${archiveSha}`;
    // WSL does not inherit HOME; embed the fixture's override in the script.
    const installScript = (archive = archivePath, sha = archiveSha, devUrl?: URL) =>
      [
        `HOME=${sh(`${work}/home`)}`,
        "export HOME",
        buildWslRuntimeInstallScript(archive, runtimeId, sha, devUrl),
      ].join("\n");
    return {
      work,
      archivePath,
      archiveSha,
      runtimeId,
      runtimeParent: `${work}/home/.t3/wsl-runtime`,
      runtimeRoot: `${work}/home/.t3/wsl-runtime/${runtimeId}`,
      serverEntry: `${work}/home/.t3/wsl-runtime/${runtimeId}/t3`,
      installScript,
      install: (archive?: string, sha?: string) => runShell(installScript(archive, sha)),
    };
  };

  const probeFixture = (fixture: ReturnType<typeof createFixture>) =>
    runShell(
      [
        `export HOME=${sh(`${fixture.work}/home`)}`,
        'export NVM_DIR="$HOME/.nvm" FNM_DIR="$HOME/.fnm" VOLTA_HOME="$HOME/.volta"',
        "bash() { (",
        "  command() {",
        '    case "$*" in',
        '      "-v node"|"-v mise"|"-v fnm"|"-v nodenv") return 1 ;;',
        '      *) builtin command "$@" ;;',
        "    esac",
        "  }",
        '  eval "$2"',
        "); }",
        buildWslRuntimeProbeScript(),
      ].join("\n"),
    );

  it("reads the launched server's dev identity instead of the production identity", () => {
    const fixture = createFixture();
    const setup =
      runShell(`mkdir -p ${sh(`${fixture.work}/home/.t3/userdata`)} ${sh(`${fixture.work}/home/.t3/dev`)}
      printf 'production-id\\n' > ${sh(`${fixture.work}/home/.t3/userdata/environment-id`)}
      printf 'development-id\\n' > ${sh(`${fixture.work}/home/.t3/dev/environment-id`)}`);
    expect(setup.status, setup.stderr).toBe(0);
    const dev = runShell(
      fixture.installScript(undefined, undefined, new URL("http://localhost:5173")),
    );
    expect(dev.status, dev.stderr).toBe(0);
    expect(readField(dev.stdout, "environmentId")).toBe("development-id");
    const prod = fixture.install();
    expect(prod.status, prod.stderr).toBe(0);
    expect(readField(prod.stdout, "environmentId")).toBe("production-id");
  });

  it("discovers version-managed Node for providers with a standalone runtime", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const nodeBin = `${fixture.work}/home/.nvm/versions/node/v24.15.0/bin`;
    const setup = runShell(
      [
        "set -eu",
        `mkdir -p ${sh(nodeBin)}`,
        `printf '%s' ${sh('#!/bin/sh\nprintf "linux-node-provider\\n"\n')} > ${sh(`${nodeBin}/node`)}`,
        `chmod +x ${sh(`${nodeBin}/node`)}`,
      ].join("\n"),
    );
    expect(setup.status, setup.stderr).toBe(0);

    const probe = probeFixture(fixture);

    expect(probe.status, probe.stderr).toBe(0);
    const resolvedPath = parseResolvedPath(probe.stdout);
    expect(resolvedPath?.split(":")).toContain(nodeBin);
    const provider = runShell(`export PATH=${sh(resolvedPath ?? "")}\nnode provider.js`);
    expect(provider.status, provider.stderr).toBe(0);
    expect(provider.stdout).toBe("linux-node-provider\n");
  });

  it("keeps the inherited PATH when bash is unavailable", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const probe = runShell(
      [
        "bash() { return 127; }",
        'export PATH="/fixture/bin:/usr/bin:/bin"',
        buildWslRuntimeProbeScript(),
      ].join("\n"),
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(parseResolvedPath(probe.stdout)).toBe("/fixture/bin:/usr/bin:/bin");
  });

  it("reuses a warm cache without touching the archive", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\nrm ${sh(fixture.archivePath)}`).status).toBe(0);

    const warm = fixture.install();

    expect(warm.status, warm.stderr).toBe(0);
    expect(parseWslRuntimeRoot(warm.stdout)).toBe(fixture.runtimeRoot);
  });

  it("retains the loader error when a bundled executable needs a missing system library", () => {
    const fixture = createFixture(
      '#!/bin/sh\nprintf "error while loading shared libraries: libatomic.so.1: cannot open shared object file\\n" >&2\nexit 127\n',
    );

    const result = fixture.install();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("libatomic.so.1");
    expect(parseWslRuntimeRoot(result.stdout)).toBeNull();
  });

  it("reinstalls a cache whose executable was truncated", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\n: > ${sh(fixture.serverEntry)}`).status).toBe(0);

    const repaired = fixture.install();

    expect(repaired.status, repaired.stderr).toBe(0);
    expect(parseWslRuntimeRoot(repaired.stdout)).toBe(fixture.runtimeRoot);
    const restored = runShell(`set -eu\ncat ${sh(fixture.serverEntry)}`);
    expect(restored.stdout).toBe(SERVER_ENTRY_SOURCE);
  });

  it("reinstalls an executable that fails --version despite a matching recorded digest", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const brokenEntry = "#!/bin/sh\nexit 42\n";
    const corrupt = runShell(
      [
        "set -eu",
        `printf '%s' ${sh(brokenEntry)} > ${sh(fixture.serverEntry)}`,
        `chmod +x ${sh(fixture.serverEntry)}`,
        `sha256sum ${sh(fixture.serverEntry)} | cut -d ' ' -f 1 > ${sh(`${fixture.runtimeRoot}/.t3code-wsl-runtime-ready`)}`,
      ].join("\n"),
    );
    expect(corrupt.status, corrupt.stderr).toBe(0);
    expect(runShell(`${sh(fixture.serverEntry)} --version`).status).toBe(42);

    const repaired = fixture.install();
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(parseWslRuntimeRoot(repaired.stdout)).toBe(fixture.runtimeRoot);
    expect(runShell(`cat ${sh(fixture.serverEntry)}`).stdout).toBe(SERVER_ENTRY_SOURCE);
    expect(runShell(`${sh(fixture.serverEntry)} --version`).status).toBe(0);
  });

  it("falls back instead of launching a corrupted cache it cannot reinstall", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    expect(runShell(`set -eu\n: > ${sh(fixture.serverEntry)}`).status).toBe(0);
    expect(runShell(`set -eu\nrm ${sh(fixture.archivePath)}`).status).toBe(0);

    const broken = fixture.install();

    expect(broken.status).not.toBe(0);
    expect(parseWslRuntimeRoot(broken.stdout)).toBeNull();
  });

  it("extracts once when two installs race for the same cache", () => {
    const fixture = createFixture();
    const raced = runShell(
      [
        "set -eu",
        `work=${sh(fixture.work)}`,
        'mkdir -p "$work/bin"',
        "real_tar=$(command -v tar)",
        `printf '#!/bin/sh\\nprintf x >> "%s/tar-calls"\\nsleep 1\\nexec %s "$@"\\n' "$work" "$real_tar" > "$work/bin/tar"`,
        'chmod +x "$work/bin/tar"',
        ': > "$work/tar-calls"',
        'PATH="$work/bin:$PATH"',
        "export PATH",
        `cat > "$work/install.sh" <<'T3CODE_INSTALL_SCRIPT'`,
        fixture.installScript(),
        "T3CODE_INSTALL_SCRIPT",
        // Keep runtime roots out of both racers' argv so their /proc scans cannot match themselves.
        'sh "$work/install.sh" > "$work/first.out" 2>&1 &',
        "first=$!",
        'sh "$work/install.sh" > "$work/second.out" 2>&1 &',
        "second=$!",
        "if wait $first; then first_status=0; else first_status=$?; fi",
        "if wait $second; then second_status=0; else second_status=$?; fi",
        `printf 'firstStatus:%s\\n' "$first_status"`,
        `printf 'secondStatus:%s\\n' "$second_status"`,
        `printf 'extractions:%s\\n' "$(wc -c < "$work/tar-calls" | tr -d ' ')"`,
        `printf 'firstRoot:%s\\n' "$(sed -n 's/^runtimeRoot://p' "$work/first.out")"`,
        `printf 'secondRoot:%s\\n' "$(sed -n 's/^runtimeRoot://p' "$work/second.out")"`,
      ].join("\n"),
    );

    expect(raced.status, raced.stderr).toBe(0);
    expect(readField(raced.stdout, "firstStatus")).toBe("0");
    expect(readField(raced.stdout, "secondStatus")).toBe("0");
    expect(readField(raced.stdout, "extractions")).toBe("1");
    expect(readField(raced.stdout, "firstRoot")).toBe(fixture.runtimeRoot);
    expect(readField(raced.stdout, "secondRoot")).toBe(fixture.runtimeRoot);
  });

  it("leaves no half-built cache when extraction fails", () => {
    const fixture = createFixture();
    const truncated = runShell(
      [
        "set -eu",
        `work=${sh(fixture.work)}`,
        'size=$(wc -c < "$work/wsl-runtime.tar.gz")',
        'head -c $((size / 2)) "$work/wsl-runtime.tar.gz" > "$work/truncated.tar.gz"',
        `printf 'sha:%s\\n' "$(sha256sum "$work/truncated.tar.gz" | cut -d ' ' -f 1)"`,
      ].join("\n"),
    );
    expect(truncated.status, truncated.stderr).toBe(0);

    const failed = fixture.install(
      `${fixture.work}/truncated.tar.gz`,
      readField(truncated.stdout, "sha"),
    );

    expect(failed.status).not.toBe(0);
    expect(parseWslRuntimeRoot(failed.stdout)).toBeNull();
    const leftovers = runShell(
      `set -eu\nfind ${sh(fixture.runtimeParent)} -mindepth 1 -maxdepth 1 -type d`,
    );
    expect(leftovers.stdout.trim()).toBe("");
  });

  it("refuses an archive whose bytes do not match the digest recorded for it", () => {
    const fixture = createFixture();

    const refused = fixture.install(fixture.archivePath, "e".repeat(64));

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("does not match its recorded SHA-256");
    expect(parseWslRuntimeRoot(refused.stdout)).toBeNull();
    const leftovers = runShell(
      `set -eu\nfind ${sh(fixture.runtimeParent)} -mindepth 1 -maxdepth 1 -type d`,
    );
    expect(leftovers.stdout.trim()).toBe("");
  });

  it("leases a warm cache across the prepare-to-spawn handoff", () => {
    const fixture = createFixture();
    expect(fixture.install().status).toBe(0);
    const selected = runShell(
      [
        "set -eu",
        `runtime_parent=${sh(fixture.runtimeParent)}`,
        'mkdir -p "$runtime_parent/sha256-current" "$runtime_parent/sha256-previous"',
        'printf ready > "$runtime_parent/sha256-current/.t3code-wsl-runtime-ready"',
        'printf ready > "$runtime_parent/sha256-previous/.t3code-wsl-runtime-ready"',
        `touch -d "10 minutes ago" ${sh(fixture.runtimeRoot)}`,
        'touch -d "1 minute ago" "$runtime_parent/sha256-previous"',
        `cat > ${sh(`${fixture.work}/select.sh`)} <<'T3CODE_SELECT_SCRIPT'`,
        fixture.installScript(),
        "T3CODE_SELECT_SCRIPT",
        `sh ${sh(`${fixture.work}/select.sh`)}`,
        `HOME=${sh(`${fixture.work}/home`)}`,
        "export HOME",
        buildWslRuntimePruneScript("sha256-current"),
        `test -d ${sh(fixture.runtimeRoot)}`,
      ].join("\n"),
    );

    expect(selected.status, `${selected.stdout}\n${selected.stderr}`).toBe(0);
  });

  // Runs the distro side on the local bash, so a Windows dev box using the wsl.exe runner skips it.
  describe.skipIf(posixShellRunner?.file !== "bash")("prepareRuntime through wsl.exe", () => {
    // Emulates `wsl.exe [-d <distro>] [--cd <dir>] [--|--exec] <argv>` in a distro with automount off.
    const layerFakeWslExe = (home: string) =>
      Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.map(ChildProcessSpawner.ChildProcessSpawner, (local) =>
          ChildProcessSpawner.make((command) => {
            if (!ChildProcess.isStandardCommand(command) || command.command !== "wsl.exe") {
              return local.spawn(command);
            }
            const args = command.args.map((word) =>
              Redacted.isRedacted(word) ? Redacted.value(word) : word,
            );
            while (args.length > 0) {
              const flag = args[0];
              if (flag === "-d" || flag === "--distribution" || flag === "--cd") {
                args.splice(0, 2);
              } else if (flag === "--" || flag === "--exec" || flag === "-e") {
                args.shift();
                break;
              } else {
                break;
              }
            }
            const [file = "sh", ...rest] =
              args[0] === "wslpath"
                ? [
                    "sh",
                    "-c",
                    'printf "wslpath: %s\\n" "$1" >&2; exit 1',
                    "wslpath",
                    args.at(-1) ?? "",
                  ]
                : args;
            return local.spawn(
              ChildProcess.make(file, rest, {
                ...command.options,
                env: { ...command.options.env, HOME: home },
                extendEnv: true,
              }),
            );
          }),
        ),
      );

    const layerWslEnvironment = (home: string) =>
      layerDesktopWslEnvironment.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerFakeWslExe(home),
            DesktopManagedPolicy.layerTest(),
            Layer.effect(
              DesktopEnvironment.DesktopEnvironment,
              Effect.map(
                Path.Path,
                (path) =>
                  ({ platform: "win32", path }) as DesktopEnvironment.DesktopEnvironment["Service"],
              ),
            ),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );

    it.live("installs the runtime when wslpath cannot translate the archive's Windows path", () => {
      const fixture = createFixture();
      return Effect.gen(function* () {
        const wsl = yield* DesktopWslEnvironment;
        // The archive's Windows path; with no drives mounted, wslpath cannot map it into the distro.
        const translated = yield* wsl.windowsToWslPath("Ubuntu", fixture.archivePath);
        expect(translated._tag).toBe("None");

        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${fixture.work}/home/.t3/userdata`, { recursive: true });
        yield* fs.writeFileString(
          `${fixture.work}/home/.t3/userdata/environment-id`,
          "fixture-environment\n",
        );
        const prepared = yield* wsl.prepareRuntime("Ubuntu", {
          windowsPath: fixture.archivePath,
          runtimeId: fixture.runtimeId,
          sha256: fixture.archiveSha,
        });

        expect(prepared).toEqual({
          ok: true,
          linuxAppRoot: fixture.runtimeRoot,
          environmentId: "fixture-environment",
        });
        const version = runShell(`${sh(fixture.serverEntry)} --version`);
        expect(version.status, version.stderr).toBe(0);
        expect(version.stdout).toBe("t3code wsl runtime test server 0.0.0\n");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(layerWslEnvironment(`${fixture.work}/home`), NodeServices.layer),
        ),
      );
    });
  });

  it("prunes old and markerless caches without touching retained, active, locked, or unrelated roots", () => {
    const result = runShell(
      [
        "set -eu",
        "work=$(mktemp -d)",
        'home="$work/home"',
        'runtime_parent="$home/.t3/wsl-runtime"',
        'mkdir -p "$runtime_parent"',
        'make_ready() { mkdir -p "$runtime_parent/$1"; printf ready > "$runtime_parent/$1/.t3code-wsl-runtime-ready"; }',
        "make_ready sha256-current",
        "make_ready sha256-previous",
        "make_ready sha256-active",
        "make_ready sha256-old",
        "make_ready sha256-locked",
        'mkdir -p "$runtime_parent/sha256-markerless" "$runtime_parent/versions"',
        'touch -d "1 minute ago" "$runtime_parent/sha256-previous"',
        'touch -d "4 minutes ago" "$runtime_parent/sha256-active"',
        'touch -d "3 minutes ago" "$runtime_parent/sha256-old"',
        'touch -d "2 minutes ago" "$runtime_parent/sha256-locked"',
        holdRuntimeBusy('"$runtime_parent/sha256-active/t3"'),
        holdInstallLock('"$runtime_parent/.sha256-locked.install.lock"'),
        `HOME="$home"`,
        "export HOME",
        buildWslRuntimePruneScript("sha256-current"),
        'test -d "$runtime_parent/sha256-current"',
        'test -d "$runtime_parent/sha256-previous"',
        'test -d "$runtime_parent/sha256-active"',
        'test -d "$runtime_parent/sha256-locked"',
        'test -d "$runtime_parent/versions"',
        'test ! -e "$runtime_parent/sha256-old"',
        'test ! -e "$runtime_parent/sha256-markerless"',
        'rm -rf "$work"',
      ].join("\n"),
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

describe("parseResolvedPath", () => {
  it("preserves spaces and apostrophes in the resolved login-shell PATH", () => {
    const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
    expect(parseResolvedPath(`nodePath:/usr/bin/node\nresolvedPath:${resolvedPath}\n`)).toBe(
      resolvedPath,
    );
  });

  it("accepts CRLF output without retaining the carriage return", () => {
    expect(parseResolvedPath("resolvedPath:/usr/local/bin:/usr/bin\r\n")).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });
});

// Path.layer joins with POSIX separators here, so the test windir is a POSIX path.
const WSL_EXE = "/windows/System32/wsl.exe";

const isAvailable = (policy?: Parameters<typeof DesktopManagedPolicy.layerTest>[0]) =>
  makeIsAvailable("win32", "/windows").pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({ exists: (path) => Effect.succeed(path === WSL_EXE) }),
        Path.layer,
        DesktopManagedPolicy.layerTest(policy),
      ),
    ),
  );

describe("makeIsAvailable", () => {
  it.effect("turns WSL off on a machine with a managed policy, even an invalid one", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isAvailable());
      assert.isFalse(yield* isAvailable({ schemaVersion: 1, organization: "Example Corp" }));
      assert.isFalse(
        yield* isAvailable(new ManagedPolicyFileError({ path: "/test", reason: "bad JSON" })),
      );
    }),
  );
});

describe("windowsToWslPathImpl", () => {
  it.effect("runs wslpath without a shell so folder names stay one literal argument", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.Command> = [];
      const stdout = Stream.make(new TextEncoder().encode("/mnt/c/a$b & c;(d)\n"));
      const spawner = ChildProcessSpawner.make((command) => {
        spawned.push(command);
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            stdout,
            stderr: Stream.empty,
            all: stdout,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
      });

      const converted = yield* windowsToWslPathImpl("Ubuntu", "C:\\a$b & c;(d)").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      assert.deepStrictEqual(converted, Option.some("/mnt/c/a$b & c;(d)"));
      assert.lengthOf(spawned, 1);
      const [command] = spawned;
      assert(command?._tag === "StandardCommand");
      assert.strictEqual(command.command, "wsl.exe");
      assert.deepStrictEqual(command.args, [
        "-d",
        "Ubuntu",
        "--exec",
        "wslpath",
        "-u",
        "C:/a$b & c;(d)",
      ]);
    }),
  );
});

describe("WSL startup probes", () => {
  const withProbe = (
    output: (command: ChildProcess.Command) => Effect.Effect<string>,
    run: Effect.Effect<void, never, DesktopWslEnvironment>,
    stateDir?: string,
    onPersist: Effect.Effect<void> = Effect.void,
  ) => {
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.fromEffect(output(command)).pipe(Stream.encodeText),
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    );
    return run.pipe(
      Effect.provide(
        layerDesktopWslEnvironment.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              DesktopManagedPolicy.layerTest(),
              Layer.effect(
                DesktopEnvironment.DesktopEnvironment,
                Effect.gen(function* () {
                  const path = yield* Path.Path;
                  const directory =
                    stateDir ?? (yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped());
                  return {
                    platform: "win32",
                    path,
                    stateDir: directory,
                  } as DesktopEnvironment.DesktopEnvironment["Service"];
                }),
              ),
            ),
          ),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.effect(
                FileSystem.FileSystem,
                Effect.map(FileSystem.FileSystem, (fs) => ({
                  ...fs,
                  rename: (from, to) => fs.rename(from, to).pipe(Effect.andThen(onPersist)),
                })),
              ).pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
        ),
      ),
    );
  };

  it.effect("allows a healthy login-shell probe that takes four seconds", () =>
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<Deferred.Deferred<void>>();
      yield* withProbe(
        () =>
          Effect.gen(function* () {
            const finish = yield* Deferred.make<void>();
            yield* Queue.offer(attempts, finish);
            yield* Deferred.await(finish);
            return "resolvedPath:/slow-but-healthy/bin\n";
          }),
        Effect.gen(function* () {
          const wsl = yield* DesktopWslEnvironment;
          const pending = yield* wsl.probeRuntime("Ubuntu", "slow").pipe(Effect.forkChild);
          yield* Queue.take(attempts);
          yield* TestClock.adjust("3 seconds");
          const second = yield* Queue.take(attempts);
          yield* TestClock.adjust("4 seconds");
          yield* Deferred.succeed(second, undefined);
          yield* TestClock.adjust("0 seconds");
          assert.equal(Queue.sizeUnsafe(attempts), 0);
          assert.deepEqual(yield* Fiber.join(pending), {
            ok: true,
            resolvedPath: "/slow-but-healthy/bin",
          });
        }),
      );
    }),
  );

  it.effect("retries a timed out login shell and caches PATH by distro and runtime", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let calls = 0;
      yield* withProbe(
        () =>
          Effect.suspend(() =>
            ++calls === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed("resolvedPath:/custom/bin:/usr/bin\n"),
          ),
        Effect.gen(function* () {
          const wsl = yield* DesktopWslEnvironment;
          const pending = yield* wsl.probeRuntime("Ubuntu", "v1").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust("3 seconds");
          assert.deepEqual(yield* Fiber.join(pending), {
            ok: true,
            resolvedPath: "/custom/bin:/usr/bin",
          });
          assert.equal(calls, 2);
          yield* wsl.probeRuntime("Ubuntu", "v1");
          assert.equal(calls, 2);
          yield* wsl.probeRuntime("Ubuntu", "v2");
          yield* wsl.probeRuntime("Debian", "v2");
          assert.equal(calls, 5);
        }),
      );
    }),
  );

  it.effect("reuses a runtime PATH after rebuilding the desktop environment", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const read = Effect.gen(function* () {
        const result = yield* (yield* DesktopWslEnvironment).probeRuntime("Ubuntu", "v1");
        assert.deepEqual(result, { ok: true, resolvedPath: "/persisted/bin" });
      });
      yield* withProbe(() => Effect.succeed("resolvedPath:/persisted/bin\n"), read, stateDir);
      yield* withProbe(() => Effect.never, read, stateDir);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns stale PATH while one refresh persists the new login-shell PATH", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const persisted = yield* Deferred.make<void>();
      let calls = 0;
      yield* withProbe(
        () =>
          Effect.suspend(() =>
            ++calls === 1
              ? Effect.succeed("resolvedPath:/old/bin\n")
              : Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.as("resolvedPath:/new/bin\n"),
                ),
          ),
        Effect.gen(function* () {
          const wsl = yield* DesktopWslEnvironment;
          assert.deepEqual(yield* wsl.probeRuntime("Ubuntu", "v1"), {
            ok: true,
            resolvedPath: "/old/bin",
          });
          const stale = yield* wsl.probeRuntime("Ubuntu", "v1");
          assert.deepEqual(stale, { ok: true, resolvedPath: "/old/bin" });
          yield* TestClock.adjust("0 seconds");
          assert.isTrue(yield* Deferred.isDone(started));
          assert.deepEqual(yield* wsl.probeRuntime("Ubuntu", "v1"), stale);
          yield* TestClock.adjust("0 seconds");
          assert.equal(calls, 2);
          yield* Deferred.succeed(finish, undefined);
          yield* Deferred.await(persisted);
        }),
        stateDir,
        Effect.suspend(() =>
          calls > 1 ? Deferred.succeed(persisted, undefined).pipe(Effect.asVoid) : Effect.void,
        ),
      );
      yield* withProbe(
        () => Effect.never,
        Effect.gen(function* () {
          const result = yield* (yield* DesktopWslEnvironment).probeRuntime("Ubuntu", "v1");
          assert.deepEqual(result, { ok: true, resolvedPath: "/new/bin" });
        }),
        stateDir,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retains cached PATH when every background probe times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let calls = 0;
      yield* withProbe(
        () =>
          Effect.suspend(() =>
            ++calls === 1
              ? Effect.succeed("resolvedPath:/working/bin\n")
              : Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        Effect.gen(function* () {
          const wsl = yield* DesktopWslEnvironment;
          const original = yield* wsl.probeRuntime("Ubuntu", "v1");
          assert.deepEqual(yield* wsl.probeRuntime("Ubuntu", "v1"), original);
          yield* Deferred.await(started);
          yield* TestClock.adjust("21 seconds");
          assert.equal(calls, 4);
          assert.deepEqual(yield* wsl.probeRuntime("Ubuntu", "v1"), original);
        }),
      );
    }),
  );

  it.effect("bounds transport retries to escalating three-, six- and twelve-second attempts", () =>
    Effect.gen(function* () {
      let calls = 0;
      const started = yield* Deferred.make<void>();
      yield* withProbe(
        () =>
          Effect.sync(() => {
            calls += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
          ),
        Effect.gen(function* () {
          const wsl = yield* DesktopWslEnvironment;
          const pending = yield* wsl.probeRuntime("Ubuntu", "v1").pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* TestClock.adjust("21 seconds");
          const result = yield* Fiber.join(pending);
          assert.isFalse(result.ok);
          assert.equal(calls, 3);
          if (!result.ok) assert.equal(result.transportFailure, "timeout");
        }),
      );
    }),
  );

  it.effect.each(["mirrored", "nat", "unknown"])(
    "caches the actual %s networking mode per distro",
    (mode) => {
      let calls = 0;
      return withProbe(
        (command) => {
          calls += 1;
          assert(ChildProcess.isStandardCommand(command));
          assert.deepEqual(command.args, [
            "-d",
            calls === 1 ? "Ubuntu" : "Debian",
            "--exec",
            "/usr/bin/wslinfo",
            "--networking-mode",
          ]);
          return Effect.succeed(mode + "\n");
        },
        Effect.gen(function* () {
          const wsl = yield* DesktopWslEnvironment;
          assert.equal(yield* wsl.getNetworkingMode("Ubuntu"), mode === "unknown" ? null : mode);
          assert.equal(yield* wsl.getNetworkingMode("Ubuntu"), mode === "unknown" ? null : mode);
          assert.equal(calls, 1);
          assert.equal(yield* wsl.getNetworkingMode("Debian"), mode === "unknown" ? null : mode);
          assert.equal(yield* wsl.getNetworkingMode("Debian"), mode === "unknown" ? null : mode);
          assert.equal(calls, 2);
        }),
      );
    },
  );
});
