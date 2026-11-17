// @effect-diagnostics nodeBuiltinImport:off - Fixtures exercise the standalone worker without Effect dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";

import {
  artifactDigests,
  databaseBackupDecision,
  localDesktopBuildEnvironment,
  claimPreparedOutput,
  localBuildInstallIdentity,
  retryPreparationInterop,
  prunePreparedOutputs,
  assertPreparedUpdate,
  buildCacheKey,
  findCachedBuild,
  assertShellVersion,
  captureLocalLinks,
  checkLocalLink,
  installedReceiptPath,
  selectUpdatePath,
  runtimeHealth,
  stopLocalRuntime,
} from "./update-local-desktop.ts";

function linkFixture(source = "wsl", target = "windows") {
  const userdata = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "update-links-"));
  NodeFS.writeFileSync(NodePath.join(userdata, "environment-id"), source);
  NodeFS.mkdirSync(NodePath.join(userdata, "secrets"));
  const credential = NodePath.join(userdata, "secrets/peer-link-fixture.bin");
  NodeFS.writeFileSync(credential, "existing-peer-token");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  db.exec(
    "CREATE TABLE peer_environment_links(environment_id TEXT, urls_json TEXT, linked_at TEXT, secret_name TEXT)",
  );
  db.prepare("INSERT INTO peer_environment_links VALUES (?, ?, ?, ?)").run(
    target,
    '["http://peer.test:3773"]',
    "original-link",
    "peer-link-fixture",
  );
  db.close();
  return {
    userdata,
    credential,
    [Symbol.dispose]() {
      NodeFS.rmSync(userdata, { recursive: true, force: true });
    },
  };
}

function peerResponse(input: string | URL | Request, init?: RequestInit, target = "windows") {
  if (String(input).endsWith("/.well-known/t3/environment"))
    return Response.json({
      environmentId: target,
      capabilities: { mcpModeLimitHeader: true, linkFence: true },
    });
  if (init?.method === "DELETE") return new Response(null, { status: 204 });
  if (new Headers(init?.headers).get("authorization") !== "Bearer existing-peer-token")
    return new Response(null, { status: 401 });
  const message = JSON.parse(String(init?.body));
  if (message.method === "initialize")
    return Response.json({ result: {} }, { headers: { "mcp-session-id": "fixture-session" } });
  if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (message.params?.name !== "t3_thread_list")
    throw new Error("Only the read-only probe is allowed");
  return Response.json({ result: { structuredContent: { total: 0 } } });
}

it.each([
  ["wsl", "windows"],
  ["windows", "wsl"],
])("proves %s → %s with the existing identity, URL and credential", async (source, target) => {
  using fixture = linkFixture(source, target);
  using _fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => peerResponse(input, init, target));
  const before = await captureLocalLinks(fixture.userdata);
  expect(before).toEqual({
    environmentId: source,
    links: [{ environmentId: target, urls: ["http://peer.test:3773"], linkedAt: "original-link" }],
  });
  expect(await checkLocalLink(fixture.userdata, before, target, 10)).toMatchObject({
    sourceEnvironmentId: source,
    targetEnvironmentId: target,
    status: "passed",
    descriptor: true,
    mcp: true,
    url: "http://peer.test:3773",
    error: "",
  });
  expect(NodeFS.readFileSync(fixture.credential, "utf8")).toBe("existing-peer-token");
  expect(await captureLocalLinks(fixture.userdata)).toEqual(before);
});

it.each(["starting", "wrong-identity", "missing-capability", "deadline"])(
  "withholds credentials when the descriptor is %s",
  async (failure) => {
    using fixture = linkFixture();
    const before = await captureLocalLinks(fixture.userdata);
    using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      failure === "starting"
        ? new Response(null, { status: 503 })
        : Response.json({
            environmentId: failure === "wrong-identity" ? "other" : "windows",
            capabilities: { mcpModeLimitHeader: true, linkFence: failure !== "missing-capability" },
          }),
    );
    expect(
      await checkLocalLink(fixture.userdata, before, "windows", failure === "deadline" ? 0 : 10),
    ).toMatchObject({
      status: "warning",
      descriptor: false,
      mcp: false,
    });
    expect(
      fetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has("authorization")),
    ).toBe(true);
  },
);

it("waits for peer identity before reading its credential or making an MCP call", async () => {
  using fixture = linkFixture();
  const before = await captureLocalLinks(fixture.userdata);
  NodeFS.rmSync(fixture.credential);
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => peerResponse(input, init));
  expect(await checkLocalLink(fixture.userdata, before, "windows", 10, true)).toMatchObject({
    status: "passed",
    descriptor: true,
    mcp: false,
  });
  expect(
    fetch.mock.calls.every(([input]) => String(input).endsWith("/.well-known/t3/environment")),
  ).toBe(true);
});

it.each(["refused", "tool-error", "malformed"])(
  "records a safe warning when authenticated MCP is %s",
  async (failure) => {
    using fixture = linkFixture();
    const before = await captureLocalLinks(fixture.userdata);
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/mcp") && init?.method === "POST") {
        if (failure === "refused") return new Response(null, { status: 401 });
        if (JSON.parse(String(init.body)).method === "tools/call")
          return Response.json({
            result:
              failure === "tool-error"
                ? { isError: true, content: [{ text: "existing-peer-token" }] }
                : {},
          });
      }
      return peerResponse(input, init);
    });
    const result = await checkLocalLink(fixture.userdata, before, "windows", 10);
    expect(result).toMatchObject({
      status: "warning",
      descriptor: true,
      mcp: false,
      error: "Authenticated read-only MCP check failed with the existing peer credential",
    });
    expect(JSON.stringify(result)).not.toContain("existing-peer-token");
  },
);

it.each(["identity", "link"])("warns when the original %s was replaced", async (failure) => {
  using fixture = linkFixture();
  const before = await captureLocalLinks(fixture.userdata);
  if (failure === "identity")
    NodeFS.writeFileSync(NodePath.join(fixture.userdata, "environment-id"), "replacement");
  else {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(fixture.userdata, "statev2.sqlite"));
    db.exec("UPDATE peer_environment_links SET linked_at = 'replacement'");
    db.close();
  }
  using fetch = vi.spyOn(globalThis, "fetch");
  expect(await checkLocalLink(fixture.userdata, before, "windows", 10)).toMatchObject({
    status: "warning",
    descriptor: false,
    mcp: false,
  });
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  [undefined, undefined, ["apps/web/src/App.tsx"], "full"],
  ["a".repeat(40), undefined, ["apps/web/src/App.tsx", "apps/server/src/bin.ts"], "wsl-only"],
  ["a".repeat(40), undefined, ["apps/web/src/App.tsx"], "wsl-only"],
  ["a".repeat(40), undefined, ["apps/server/src/bin.ts"], "wsl-only"],
  ["a".repeat(40), undefined, ["packages/contracts/src/environment.ts"], "full"],
  ["a".repeat(40), undefined, ["packages/client-runtime/src/rpc.ts"], "full"],
  ["a".repeat(40), undefined, ["apps/server/src/persistence/Migrations/100_New.ts"], "full"],
  ["a".repeat(40), undefined, ["apps/server/src/persistence/databaseMigrationHead.ts"], "full"],
  ["a".repeat(40), undefined, ["apps/server/src/threadWorkspace/workspaceMigration.ts"], "full"],
  ["a".repeat(40), undefined, ["apps/server/src/db/migrations/1.sql"], "full"],
  ["a".repeat(40), undefined, ["apps/desktop/src/main.ts"], "full"],
  ["a".repeat(40), undefined, ["pnpm-lock.yaml"], "full"],
  ["a".repeat(40), undefined, ["apps/server/package.json"], "full"],
  ["a".repeat(40), undefined, ["apps/server/native/module.node"], "full"],
  ["a".repeat(40), undefined, ["packages/shared/src/Net.ts"], "full"],
  ["a".repeat(40), "full", [], "full"],
  [undefined, "wsl-only", [], "wsl-only"],
] as const)("selects a safe update path (%s, %s, %s)", (commit, force, changed, expected) => {
  expect(selectUpdatePath(commit, force, changed)).toBe(expected);
});

it("requires the expected runtime executable and original environment identity", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "update-runtime-"));
  const runtime = NodePath.join(home, "wsl-runtime/sha256-fixture/t3");
  NodeFS.mkdirSync(NodePath.dirname(runtime), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(home, "userdata"));
  NodeFS.copyFileSync(process.execPath, runtime);
  const child = NodeChildProcess.spawn(
    runtime,
    ["-e", 'process.stdin.resume(); process.stdout.write("ready")'],
    { stdio: "pipe" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("error", reject);
    });
    NodeFS.writeFileSync(
      NodePath.join(home, "userdata/server-runtime.json"),
      JSON.stringify({ pid: child.pid, port: 3774 }),
    );
    NodeFS.writeFileSync(NodePath.join(home, "userdata/environment-id"), "original");
    using fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ environmentId: "original" }));
    expect(await runtimeHealth(home, "fixture", "original")).toMatchObject({
      healthy: true,
      pid: child.pid,
      environmentId: "original",
    });
    fetch.mockResolvedValue(Response.json({ environmentId: "replacement" }));
    expect(await runtimeHealth(home, "fixture", "original")).toMatchObject({
      healthy: false,
      pid: child.pid,
    });
    fetch.mockResolvedValue(new Response("not JSON"));
    expect(await runtimeHealth(home, "fixture", "original")).toMatchObject({
      healthy: false,
      pid: child.pid,
    });
    expect(await runtimeHealth(home, "other", "original")).toEqual({ healthy: false });
  } finally {
    child.stdin!.end();
    await exited;
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "stops the captured runtime with bounded grace (force=%s)",
  async (force) => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "update-stop-"));
    const runtime = NodePath.join(home, "wsl-runtime/sha256-fixture/t3");
    NodeFS.mkdirSync(NodePath.dirname(runtime), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(home, "userdata"));
    NodeFS.copyFileSync(process.execPath, runtime);
    const child = NodeChildProcess.spawn(
      runtime,
      [
        "-e",
        `
    process.on('SIGTERM', () => {
      process.stdout.write('terminated');
      ${force ? "" : "process.exit(0)"}
    });
    process.stdin.resume();
    process.stdout.write('ready');
  `,
      ],
      { stdio: "pipe" },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
      });
      NodeFS.writeFileSync(
        NodePath.join(home, "userdata/server-runtime.json"),
        JSON.stringify({ pid: child.pid, port: 3774 }),
      );
      using _fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => Response.json({ environmentId: "original" }));
      using signals = vi.spyOn(process, "kill");
      await expect(stopLocalRuntime(home, "other", "original")).rejects.toThrow(
        "identity is unknown",
      );
      await expect(stopLocalRuntime(home, "fixture", "replacement")).rejects.toThrow(
        "identity is unknown",
      );
      expect(signals).not.toHaveBeenCalled();
      vi.useFakeTimers();
      const terminated = new Promise<void>((resolve) =>
        child.stdout!.once("data", () => resolve()),
      );
      const stopping = stopLocalRuntime(home, "fixture", "original");
      await terminated;
      expect(signals.mock.calls).toEqual([[child.pid, "SIGTERM"]]);
      if (force) {
        await vi.advanceTimersByTimeAsync(4900);
        expect(signals.mock.calls).toEqual([[child.pid, "SIGTERM"]]);
        await vi.advanceTimersByTimeAsync(100);
      }
      await exited;
      await vi.advanceTimersByTimeAsync(100);
      expect(await stopping).toEqual({ stopped: true, pid: child.pid, forced: force });
      expect(signals.mock.calls).toEqual(
        force
          ? [
              [child.pid, "SIGTERM"],
              [child.pid, "SIGKILL"],
            ]
          : [[child.pid, "SIGTERM"]],
      );
    } finally {
      vi.useRealTimers();
      child.kill("SIGKILL");
      await exited;
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  },
);

it.each([
  "packages/contracts/src/environment.ts",
  "packages/client-runtime/src/rpc.ts",
  "apps/server/src/persistence/Migrations/100_New.ts",
  "apps/server/src/threadWorkspace/workspaceMigration.ts",
])("refuses a forced runtime update across an incompatible change: %s", (file) => {
  expect(() => selectUpdatePath("a".repeat(40), "wsl-only", [file])).toThrow("--full");
});

it("refuses a runtime-only update across a version bump", async () => {
  const manifest = (version: string) => () => Promise.resolve(JSON.stringify({ version }));
  await expect(assertShellVersion(manifest("0.1.9"), "0.1.9")).resolves.toBeUndefined();
  await expect(assertShellVersion(manifest("0.1.9"), "0.1.10")).rejects.toThrow("--full");
});

it("resolves the installed receipt from --install-dir unless one is given explicitly", async () => {
  const toLinux = vi.fn((path: string) => Promise.resolve(`/mnt/c/${path.slice(3)}`));
  await expect(
    installedReceiptPath({ "install-dir": "C:\\Apps\\Weavewing" }, toLinux),
  ).resolves.toBe("/mnt/c/Apps\\Weavewing/.weavewing-local-update.json");
  await expect(
    installedReceiptPath({ "install-dir": "C:\\x", "installed-receipt": "/r.json" }, toLinux),
  ).resolves.toBe("/r.json");
  await expect(installedReceiptPath({}, toLinux)).resolves.toBeUndefined();
});

it("rejects stale commits, config, missing files and changed prepared content", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prepared-update-"));
  try {
    const artifact = NodePath.join(root, "client");
    NodeFS.mkdirSync(artifact);
    const file = NodePath.join(artifact, "index.html");
    NodeFS.writeFileSync(file, "original");
    const config = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(config, "config");
    const prepared = {
      schema: 2 as const,
      commit: "a".repeat(40),
      updatePath: "full",
      cacheKey: "cache",
      files: artifactDigests([artifact, config]),
      artifacts: artifactDigests([artifact]),
      staged: artifact,
    };
    expect(() => assertPreparedUpdate(prepared, prepared.commit)).not.toThrow();
    expect(() => assertPreparedUpdate(prepared, "b".repeat(40))).toThrow("commit");
    NodeFS.writeFileSync(config, "changed config");
    expect(() => assertPreparedUpdate(prepared, prepared.commit)).toThrow("Prepared");
    NodeFS.writeFileSync(config, "config");
    NodeFS.writeFileSync(file, "changed client");
    expect(() => assertPreparedUpdate(prepared, prepared.commit)).toThrow("Prepared");
    NodeFS.writeFileSync(file, "original");
    NodeFS.writeFileSync(NodePath.join(artifact, "extra.js"), "extra");
    expect(() => assertPreparedUpdate(prepared, prepared.commit)).toThrow("Prepared");
    NodeFS.rmSync(file);
    expect(() => assertPreparedUpdate(prepared, prepared.commit)).toThrow("Prepared");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keys cached builds by commit, tool inputs and update path", () => {
  const inputs = { commit: "a".repeat(40), updatePath: "full", monitor: "first" };
  expect(buildCacheKey(inputs)).toBe(buildCacheKey({ ...inputs }));
  for (const replacement of [
    { commit: "b".repeat(40) },
    { updatePath: "wsl-only" },
    { monitor: "second" },
  ])
    expect(buildCacheKey({ ...inputs, ...replacement })).not.toBe(buildCacheKey(inputs));
});

it("reuses completed builds before staging and rejects changed artifacts", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "update-cache-"));
  try {
    const directory = NodePath.join(root, "attempt");
    NodeFS.mkdirSync(directory);
    const artifact = NodePath.join(directory, "runtime.tar.gz");
    NodeFS.writeFileSync(artifact, "verified runtime");
    NodeFS.writeFileSync(
      NodePath.join(directory, "build-cache.json"),
      JSON.stringify({ schema: 1, cacheKey: "inputs", artifacts: artifactDigests([artifact]) }),
    );
    expect(findCachedBuild(root, "inputs")).toBe(directory);
    expect(findCachedBuild(root, "other inputs")).toBeUndefined();
    NodeFS.writeFileSync(artifact, "modified runtime");
    expect(findCachedBuild(root, "inputs")).toBeUndefined();
    NodeFS.rmSync(artifact);
    expect(findCachedBuild(root, "inputs")).toBeUndefined();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("excludes ambient build settings and origins from local builds", () => {
  const clean = localDesktopBuildEnvironment({ HOME: "/fixture", PATH: "/bin" });
  const contaminated = localDesktopBuildEnvironment({
    HOME: "/fixture",
    PATH: "/bin",
    VITE_HTTP_URL: "http://localhost",
    VITE_WS_URL: "ws://localhost",
    VITE_RELEASE_CHANNEL: "preview",
    VITE_HOSTED_APP_URL: "https://preview.test",
    APP_VERSION: "wrong",
    VERCEL_ENV: "production",
    VERCEL_URL: "preview.test",
    NODE_ENV: "development",
    NODE_OPTIONS: "--require /untrusted.cjs",
  });
  expect(contaminated).toEqual(clean);
  expect(contaminated).not.toHaveProperty("VITE_HTTP_URL");
  expect(contaminated).not.toHaveProperty("VITE_WS_URL");
});

it.each([".activation-claimed", ".preparation-active"])(
  "reclaims %s only when its PID and start time no longer identify an owner",
  async (name) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prepared-owner-"));
    try {
      const marker = NodePath.join(root, name);
      await claimPreparedOutput(marker);
      await expect(claimPreparedOutput(marker)).rejects.toThrow("active");
      const ownerFile = NodePath.join(marker, "owner.json");
      const owner = JSON.parse(NodeFS.readFileSync(ownerFile, "utf8"));
      NodeFS.writeFileSync(ownerFile, JSON.stringify({ ...owner, startTime: "previous-process" }));
      await expect(claimPreparedOutput(marker)).resolves.toBeUndefined();
      NodeFS.writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: 2147483647 }));
      await expect(claimPreparedOutput(marker)).resolves.toBeUndefined();
      NodeFS.writeFileSync(ownerFile, "{");
      NodeFS.utimesSync(marker, 1, 1);
      await expect(claimPreparedOutput(marker)).resolves.toBeUndefined();
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("invalidates cached builds after a lockfile, local config, or dependency install change", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "build-install-"));
  try {
    NodeFS.mkdirSync(NodePath.join(root, "apps/web"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(root, "node_modules"));
    const identity = () => buildCacheKey(localBuildInstallIdentity(root));
    for (const name of ["pnpm-lock.yaml", "node_modules/.modules.yaml", ".env.local"]) {
      const before = identity();
      NodeFS.writeFileSync(NodePath.join(root, name), "changed input");
      expect(identity()).not.toBe(before);
    }
    const before = identity();
    NodeFS.renameSync(NodePath.join(root, "node_modules"), NodePath.join(root, "old-modules"));
    NodeFS.mkdirSync(NodePath.join(root, "node_modules"));
    NodeFS.copyFileSync(
      NodePath.join(root, "old-modules/.modules.yaml"),
      NodePath.join(root, "node_modules/.modules.yaml"),
    );
    expect(identity()).not.toBe(before);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("retries preparation interop stalls, bounds attempts, and preserves deterministic failures", async () => {
  const transient = new Error("accept4 failed 110");
  const run = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue("prepared");
  await expect(retryPreparationInterop(run)).resolves.toBe("prepared");
  expect(run).toHaveBeenCalledTimes(2);
  const stalled = vi.fn().mockRejectedValue(transient);
  await expect(retryPreparationInterop(stalled)).rejects.toBe(transient);
  expect(stalled).toHaveBeenCalledTimes(3);
  const failure = new Error("Unowned candidate");
  const invalid = vi.fn().mockRejectedValue(failure);
  await expect(retryPreparationInterop(invalid)).rejects.toBe(failure);
  expect(invalid).toHaveBeenCalledTimes(1);
});

it("prunes crashed preparations and activations while retaining a live owner", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prune-prepared-"));
  try {
    for (let index = 0; index < 6; index++) {
      const output = NodePath.join(root, String(index));
      NodeFS.mkdirSync(output);
      NodeFS.writeFileSync(
        NodePath.join(output, "config.json"),
        JSON.stringify({ output, updatePath: "wsl-only" }),
      );
      if (index >= 2)
        NodeFS.writeFileSync(
          NodePath.join(output, "build-cache.json"),
          JSON.stringify({ schema: 1 }),
        );
      if (index < 3) {
        const marker = NodePath.join(
          output,
          index === 1 ? ".activation-claimed" : ".preparation-active",
        );
        await claimPreparedOutput(marker);
        if (index < 2)
          NodeFS.writeFileSync(
            NodePath.join(marker, "owner.json"),
            JSON.stringify({ platform: "linux", pid: 2147483647, startTime: "dead" }),
          );
      }
      NodeFS.utimesSync(output, index + 1, index + 1);
    }
    await prunePreparedOutputs(root, NodePath.join(root, "5"), NodePath.join(root, "evidence"));
    expect(NodeFS.existsSync(NodePath.join(root, "0"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(root, "1"))).toBe(false);
    for (const index of [2, 3, 4, 5])
      expect(NodeFS.existsSync(NodePath.join(root, String(index)))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(root, "evidence/0/config.json"))).toBe(true);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("backs up the database unless installed and candidate migrations are provably identical", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "migration-backup-"));
  const git = async (...args: string[]) => {
    const result = NodeChildProcess.spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = async () => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  try {
    await git("init");
    const persistence = NodePath.join(root, "apps/server/src/persistence");
    NodeFS.mkdirSync(NodePath.join(persistence, "Migrations"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(persistence, "Migrations.ts"), "registry");
    const migration = NodePath.join(persistence, "Migrations/001_Initial.ts");
    NodeFS.writeFileSync(migration, "initial");
    const installed = await commit();
    NodeFS.writeFileSync(NodePath.join(root, "web.ts"), "new UI");
    const unchanged = await commit();
    expect(await databaseBackupDecision(git, installed, unchanged)).toMatchObject({
      required: false,
      reason: "migration-set-unchanged",
      installedCommit: installed,
    });
    expect(await databaseBackupDecision(git, unchanged, unchanged)).toMatchObject({
      required: false,
    });
    for (const unknown of [undefined, "f".repeat(40)])
      expect(await databaseBackupDecision(git, unknown, unchanged)).toMatchObject({
        required: true,
        reason: "installed-history-unavailable",
      });
    NodeFS.writeFileSync(NodePath.join(persistence, "Migrations/002_New.ts"), "new migration");
    const added = await commit();
    expect(await databaseBackupDecision(git, installed, added)).toMatchObject({
      required: true,
      reason: "migration-set-changed",
    });
    expect(await databaseBackupDecision(git, added, installed)).toMatchObject({ required: true });
    NodeFS.writeFileSync(migration, "edited historical migration");
    const edited = await commit();
    expect(await databaseBackupDecision(git, added, edited)).toMatchObject({
      required: true,
      reason: "migration-set-changed",
    });
    NodeFS.writeFileSync(NodePath.join(persistence, "Migrations.ts"), "changed registry");
    const registry = await commit();
    expect(await databaseBackupDecision(git, edited, registry)).toMatchObject({
      required: true,
      reason: "migration-set-changed",
    });
    NodeFS.rmSync(NodePath.join(persistence, "Migrations.ts"));
    const missing = await commit();
    expect(await databaseBackupDecision(git, missing, missing)).toMatchObject({
      required: true,
      reason: "migration-set-unavailable",
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("does not retry a staging timeout but retries timeouts for explicitly idempotent probes", async () => {
  const timeout = new Error("powershell.exe timed out after 300000ms");
  const staging = vi.fn().mockRejectedValue(timeout);
  await expect(retryPreparationInterop(staging)).rejects.toBe(timeout);
  expect(staging).toHaveBeenCalledTimes(1);
  const probe = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValue("alive");
  await expect(retryPreparationInterop(probe, true)).resolves.toBe("alive");
  expect(probe).toHaveBeenCalledTimes(2);
});
