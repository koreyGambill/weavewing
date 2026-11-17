// @effect-diagnostics nodeBuiltinImport:off - Fixtures exercise the standalone worker without Effect dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";

import {
  artifactDigests,
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

it("rejects stale receipts, config, missing files and changed prepared content", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prepared-update-"));
  try {
    const artifact = NodePath.join(root, "client");
    NodeFS.mkdirSync(artifact);
    const file = NodePath.join(artifact, "index.html");
    NodeFS.writeFileSync(file, "original");
    const receipt = NodePath.join(root, "installed.json");
    NodeFS.writeFileSync(receipt, "installed");
    const config = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(config, "config");
    const prepared = {
      schema: 1 as const,
      commit: "a".repeat(40),
      updatePath: "full",
      cacheKey: "cache",
      installed: artifactDigests([receipt]),
      files: artifactDigests([artifact, config]),
      artifacts: artifactDigests([artifact]),
      staged: artifact,
    };
    expect(() => assertPreparedUpdate(prepared, prepared.commit)).not.toThrow();
    expect(() => assertPreparedUpdate(prepared, "b".repeat(40))).toThrow("commit");
    NodeFS.writeFileSync(receipt, "new install");
    expect(() => assertPreparedUpdate(prepared, prepared.commit)).toThrow("Installed");
    NodeFS.writeFileSync(receipt, "installed");
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
