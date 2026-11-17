#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off globalTimers:off - The detached worker runs under Electron without repository dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";

/** Local installs update through desktop-install and must never poll a public release feed. */
export function localDesktopBuildEnvironment(env: NodeJS.ProcessEnv) {
  const inherited = Object.fromEntries(
    [
      "HOME",
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "USER",
      "LOGNAME",
      "SHELL",
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "WSL_INTEROP",
      "WSL_DISTRO_NAME",
      "WSLENV",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
  return {
    ...inherited,
    T3CODE_SINGLE_ORIGIN_DEV: "1",
    T3CODE_DESKTOP_UPDATE_REPOSITORY: "",
    GITHUB_REPOSITORY: "",
  };
}

/** Identifies the dependency installation and local config files that Git does not cover. */
export function localBuildInstallIdentity(repo: string) {
  const modules = NodeFS.statSync(NodePath.join(repo, "node_modules"), { throwIfNoEntry: false });
  const envFiles = [repo, NodePath.join(repo, "apps/web")].flatMap((directory) =>
    NodeFS.readdirSync(directory)
      .filter((name) => /^\.env(?:\.|$)/.test(name))
      .sort()
      .map((name) => NodePath.join(directory, name)),
  );
  return {
    files: artifactDigests([
      NodePath.join(repo, "pnpm-lock.yaml"),
      NodePath.join(repo, "node_modules/.modules.yaml"),
      NodePath.join(repo, "node_modules/.pnpm/lock.yaml"),
    ]),
    envFiles: Object.fromEntries(envFiles.map((file) => [file, fileDigest(file)])),
    modules: modules ? [modules.dev, modules.ino, modules.mtimeMs] : null,
  };
}

/** Retries preparation launches only for transient Windows interop failures. */
export async function retryPreparationInterop<T>(operation: () => Promise<T>, idempotent = false) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt === 3 ||
        !(
          /accept4.*110|WSAETIMEDOUT/i.test(String(error)) ||
          (idempotent && /timed out after/i.test(String(error)))
        )
      )
        throw error;
      console.warn(`Preparation interop launch stalled; retrying (${attempt}/3).`);
    }
  }
}

// The ownership database holds a lifetime lock and must never enter a backup.
const stateFiles = [
  "settings.json",
  "keybindings.json",
  "environment-id",
  "anonymous-id",
  "secrets",
  "thread-workspaces",
  "thread-notes",
  "themes",
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
];

let helperReceiptDirectory: string | undefined;
const pendingHelpers: Array<{ pid: number; platform: string; role: string; at: string }> = [];

function recordHelper(pid: number, role: string) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Helper receipts describe the actual standalone host process.
  pendingHelpers.push({ pid, platform: NodeOS.platform(), role, at: new Date().toISOString() });
  if (!helperReceiptDirectory) return;
  NodeFS.mkdirSync(helperReceiptDirectory, { recursive: true, mode: 0o700 });
  for (const helper of pendingHelpers.splice(0)) {
    NodeFS.writeFileSync(
      NodePath.join(helperReceiptDirectory, `${helper.platform}-${helper.pid}.json`),
      JSON.stringify(helper),
    );
  }
}

async function run(command: string, args: string[], options: NodeChildProcess.SpawnOptions = {}) {
  const { timeout, ...spawnOptions } = options;
  const child = NodeChildProcess.spawn(command, args, { stdio: "inherit", ...spawnOptions });
  if (child.pid) recordHelper(child.pid, NodePath.basename(command));
  child.stdin?.end();
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    child.kill("SIGTERM");
  };
  const timer = timeout !== undefined && timeout > 0 ? setTimeout(expire, timeout) : undefined;
  if (timeout !== undefined && timeout <= 0) expire();
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (timedOut)
          reject(
            new Error(
              `${NodePath.basename(command)} timed out after ${timeout}ms; snapshot helper stopped.`,
            ),
          );
        else if (code !== 0)
          reject(new Error(`${command} exited ${code ?? signal}: ${stderr.trim()}`));
        else resolve();
      });
    });
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function snapshot(database: string, destination: string) {
  const { DatabaseSync, backup } = await import("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    // One step copies every page under one read snapshot, so WAL writers cannot restart it;
    // VACUUM INTO rebuilds the database and took over 4 minutes on a 3 GB store.
    await backup(db, destination, { rate: 2_147_483_647 });
  } finally {
    db.close();
  }
}

async function backupState(
  source: string,
  destination: string,
  timeout = 240_000,
  databaseBackup?: { required: boolean; reason: string },
) {
  NodeFS.mkdirSync(destination, { mode: 0o700 });
  try {
    const database = NodePath.join(source, "statev2.sqlite");
    const required =
      databaseBackup?.required !== false || databaseBackup.reason !== "migration-set-unchanged";
    const ran = required && NodeFS.existsSync(database);
    if (ran) {
      await run(
        process.execPath,
        [
          NodeURL.fileURLToPath(import.meta.url),
          "--snapshot",
          database,
          NodePath.join(destination, "statev2.sqlite"),
          helperReceiptDirectory!,
        ],
        { stdio: "pipe", timeout },
      );
      NodeFS.chmodSync(NodePath.join(destination, "statev2.sqlite"), 0o600);
    }
    for (const name of stateFiles) {
      const file = NodePath.join(source, name);
      if (NodeFS.existsSync(file))
        NodeFS.cpSync(file, NodePath.join(destination, name), {
          recursive: true,
          dereference: true,
        });
    }
    return {
      backedUp: true,
      path: destination,
      databaseBackup: {
        ran,
        reason: !required
          ? "migration-set-unchanged"
          : !ran
            ? "database-missing"
            : (databaseBackup?.reason ?? "migration-status-unknown"),
      },
    };
  } catch (error) {
    NodeFS.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Skips the database copy only when both revisions have the same known migration set. */
export async function databaseBackupDecision(
  git: (...args: string[]) => Promise<string>,
  installedCommit: string | undefined,
  candidateCommit: string,
) {
  const decision = {
    required: true,
    reason: "installed-history-unavailable",
    installedCommit,
    candidateCommit,
  };
  if (!installedCommit) return decision;
  try {
    await git("merge-base", "--is-ancestor", installedCommit, candidateCommit);
    const paths = [
      "apps/server/src/persistence/Migrations.ts",
      "apps/server/src/persistence/Migrations",
      "apps/server/src/persistence/reconcileV2PreviewMigration.ts",
      "apps/server/src/persistence/initializeV2Database.ts",
      "apps/server/src/persistence/databaseMigrationHead.ts",
    ];
    const migrationSet = async (commit: string) => {
      const tree = await git("ls-tree", "-r", commit, "--", ...paths);
      if (
        !tree.includes("\tapps/server/src/persistence/Migrations.ts") ||
        !/\tapps\/server\/src\/persistence\/Migrations\/\d+_[^\n]+\.ts/.test(tree)
      )
        throw new Error("Migration set unavailable");
      return tree;
    };
    decision.reason = "migration-set-unavailable";
    const installed = await migrationSet(installedCommit);
    const candidate = await migrationSet(candidateCommit);
    return {
      ...decision,
      required: installed !== candidate,
      reason: installed === candidate ? "migration-set-unchanged" : "migration-set-changed",
    };
  } catch {
    return decision;
  }
}

// The loose client's marker is the build version; a runtime-only update keeps the installed shell.
export async function assertShellVersion(
  readShellManifest: () => Promise<string>,
  version: string,
) {
  const shellVersion = JSON.parse(await readShellManifest()).version;
  if (shellVersion !== version)
    throw new Error(
      `Installed shell is ${shellVersion} but this build is ${version}; a runtime-only update would orphan its client. Use --full.`,
    );
}

/** An explicit receipt wins; otherwise the install directory's receipt, for plan-only runs too. */
export async function installedReceiptPath(
  values: { "installed-receipt"?: string; "install-dir"?: string },
  toLinuxPath: (windowsPath: string) => Promise<string>,
) {
  if (values["installed-receipt"]) return values["installed-receipt"];
  if (!values["install-dir"]) return undefined;
  return NodePath.join(await toLinuxPath(values["install-dir"]), ".weavewing-local-update.json");
}

export function selectUpdatePath(
  shellCommit: string | undefined,
  force: "full" | "wsl-only" | undefined,
  changed: readonly string[],
) {
  const incompatible = changed.some((file) =>
    /^packages\/(contracts|client-runtime|shared)\/|migrat/i.test(file),
  );
  if (force === "wsl-only" && incompatible)
    throw new Error("Shared wire contracts or migrations changed; use --full.");
  if (force === "full" || incompatible) return "full";
  if (force === "wsl-only") return force;
  if (!shellCommit || !/^[0-9a-f]{40}$/.test(shellCommit)) return "full";
  // Shared packages and dependency/build inputs can also change the Electron shell.
  return changed.every(
    (file) =>
      /^(apps\/(web|server)\/|packages\/provider-[^/]+\/)/.test(file) &&
      !/(^|\/)package\.json$|(^|\/)native\/|\.(node|dll|so|dylib)$/.test(file),
  )
    ? "wsl-only"
    : "full";
}

export async function runtimeHealth(home: string, digest: string, environmentId?: string) {
  try {
    const runtime = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "userdata/server-runtime.json"), "utf8"),
    );
    const executable = NodeFS.realpathSync(`/proc/${runtime.pid}/exe`);
    const expected = NodePath.join(home, "wsl-runtime", `sha256-${digest}`, "t3");
    if (executable !== expected) return { healthy: false };
    const identity =
      environmentId ??
      NodeFS.readFileSync(NodePath.join(home, "userdata/environment-id"), "utf8").trim();
    const descriptor = await fetch(`http://127.0.0.1:${runtime.port}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(1000),
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .catch(() => null);
    const descriptorId =
      descriptor && typeof descriptor === "object" && "environmentId" in descriptor
        ? descriptor.environmentId
        : undefined;
    return {
      healthy: !!identity && descriptorId === identity,
      executable,
      pid: runtime.pid,
      port: runtime.port,
      environmentId: descriptorId,
    };
  } catch {
    return { healthy: false };
  }
}

/** Stops only the verified runtime, allowing shutdown reconciliation before forcing exit. */
export async function stopLocalRuntime(home: string, digest: string, environmentId: string) {
  const current = await runtimeHealth(home, digest, environmentId);
  if (!current.healthy || !current.executable || !current.pid)
    throw new Error(
      "Runtime is not healthy or its identity is unknown; refusing to stop an unverified process.",
    );
  const identity = () => {
    try {
      const stat = NodeFS.readFileSync(`/proc/${current.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return undefined;
      const executable = NodeFS.realpathSync(`/proc/${current.pid}/exe`);
      // Another binary on this PID means the runtime already exited and the PID was reused.
      if (executable !== current.executable) return undefined;
      // Linux start time distinguishes a reused PID, including another launch of the same binary.
      return fields[19];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const original = identity();
  if (!original) return { stopped: true, pid: current.pid, forced: false };
  const running = () => {
    const actual = identity();
    return actual !== undefined && actual === original;
  };
  const signal = (value: NodeJS.Signals) => {
    if (!running()) return;
    try {
      process.kill(current.pid!, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 5000;
  while (running() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const forced = running();
  if (forced) {
    signal("SIGKILL");
    const killDeadline = Date.now() + 1000;
    while (running() && Date.now() < killDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (running()) throw new Error("Runtime did not exit after SIGKILL; refusing activation.");
  }
  return { stopped: true, pid: current.pid, forced };
}

async function checkMcpResponds(endpoint: string, authorization: string, deadline: number) {
  const requestSignal = () => {
    if (Date.now() >= deadline) throw new Error("MCP health deadline expired");
    return AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(deadline - Date.now()))));
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization,
    "T3-Mode-Limit": "approval-required/plan",
  };
  async function request(message: unknown) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      redirect: "error",
      signal: requestSignal(),
    });
    if (!response.ok) throw new Error(`MCP returned HTTP ${response.status}`);
    const session = response.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    const text = await response.text();
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)))
          .find((value) => value.id !== undefined)
      : text
        ? JSON.parse(text)
        : undefined;
    if (payload?.error) throw new Error(`MCP failed: ${JSON.stringify(payload.error)}`);
    return payload?.result;
  }
  try {
    await request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "weavewing-local-update", version: "1" },
      },
    });
    headers["mcp-protocol-version"] = "2025-06-18";
    await request({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = await request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "t3_thread_list",
        arguments: {
          allProjects: true,
          includeSubagents: true,
          limit: 1,
        },
      },
    });
    if (result?.isError || !Number.isInteger(result?.structuredContent?.total))
      throw new Error("MCP returned no thread count");
  } finally {
    if (headers["mcp-session-id"] && Date.now() < deadline)
      await fetch(endpoint, {
        method: "DELETE",
        redirect: "error",
        headers,
        signal: requestSignal(),
      }).catch(() => undefined);
  }
}

interface LinkSnapshot {
  environmentId: string;
  links: Array<{ environmentId: string; urls: string[]; linkedAt: string }>;
}

/** Reads the saved identity and peer routes without opening state for writes or exporting credentials. */
export async function captureLocalLinks(userdata: string): Promise<LinkSnapshot> {
  const environmentId = NodeFS.readFileSync(
    NodePath.join(userdata, "environment-id"),
    "utf8",
  ).trim();
  if (!environmentId) throw new Error("Environment identity is empty");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(NodePath.join(userdata, "statev2.sqlite"), { readOnly: true });
  try {
    const links = db
      .prepare("SELECT environment_id, urls_json, linked_at FROM peer_environment_links")
      .all()
      .map((row) => {
        if (
          typeof row.environment_id !== "string" ||
          typeof row.urls_json !== "string" ||
          typeof row.linked_at !== "string"
        )
          throw new Error("Invalid stored peer link");
        const urls: unknown = JSON.parse(row.urls_json);
        if (!Array.isArray(urls) || !urls.every((url): url is string => typeof url === "string"))
          throw new Error("Invalid stored peer URLs");
        return { environmentId: row.environment_id, urls, linkedAt: row.linked_at };
      });
    return { environmentId, links };
  } finally {
    db.close();
  }
}

/** Probes a saved peer with its existing credential and returns a warning for any failure. */
export async function checkLocalLink(
  userdata: string,
  before: LinkSnapshot,
  targetId: string,
  seconds: number,
  descriptorOnly = false,
) {
  const result = {
    sourceEnvironmentId: before.environmentId,
    targetEnvironmentId: targetId,
    status: "warning",
    descriptor: false,
    mcp: false,
    url: "",
    error: "",
  };
  const deadline = Date.now() + seconds * 1000;
  try {
    const current = await captureLocalLinks(userdata);
    if (current.environmentId !== before.environmentId)
      throw new Error("Source environment identity changed");
    const link = before.links.find((item) => item.environmentId === targetId);
    const stored = current.links.find((item) => item.environmentId === targetId);
    if (!link || !stored || link.linkedAt !== stored.linkedAt)
      throw new Error("Existing peer link is missing or was replaced");
    for (const url of link.urls) {
      if (Date.now() >= deadline) break;
      try {
        const origin = new URL(url);
        if (origin.username || origin.password || !["http:", "https:"].includes(origin.protocol))
          throw new Error("Invalid peer origin");
        const response = await fetch(new URL("/.well-known/t3/environment", origin), {
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(2000, Math.floor(deadline - Date.now()))),
          ),
        });
        if (!response.ok) continue;
        const descriptor = await response.json();
        if (
          descriptor === null ||
          typeof descriptor !== "object" ||
          !("environmentId" in descriptor) ||
          descriptor.environmentId !== targetId ||
          !("capabilities" in descriptor) ||
          descriptor.capabilities === null ||
          typeof descriptor.capabilities !== "object" ||
          !("mcpModeLimitHeader" in descriptor.capabilities) ||
          descriptor.capabilities.mcpModeLimitHeader !== true ||
          !("linkFence" in descriptor.capabilities) ||
          descriptor.capabilities.linkFence !== true
        )
          continue;
        result.descriptor = true;
        result.url = origin.origin;
        break;
      } catch {
        /* Another existing route may answer while a peer starts. */
      }
    }
    if (!result.descriptor)
      throw new Error(
        "Existing peer URLs did not answer with the expected identity and link capabilities",
      );
    if (descriptorOnly) {
      result.status = "passed";
      return result;
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(userdata, "statev2.sqlite"), { readOnly: true });
    let secretName;
    try {
      secretName = db
        .prepare("SELECT secret_name FROM peer_environment_links WHERE environment_id = ?")
        .get(targetId)?.secret_name;
    } finally {
      db.close();
    }
    if (typeof secretName !== "string" || !/^peer-link-[a-z0-9-]+$/i.test(secretName))
      throw new Error("Existing peer credential is unavailable");
    const token = NodeFS.readFileSync(
      NodePath.join(userdata, "secrets", `${secretName}.bin`),
      "utf8",
    );
    await checkMcpResponds(`${result.url}/mcp`, `Bearer ${token}`, deadline);
    result.mcp = true;
    result.status = "passed";
  } catch (error) {
    // Peer responses can contain private data; retain only our own failure categories.
    result.error = result.descriptor
      ? "Authenticated read-only MCP check failed with the existing peer credential"
      : error instanceof Error
        ? error.message
        : "Peer identity check failed";
  }
  return result;
}

async function worker(mode: string, configFile: string, extra: string[]) {
  const config = JSON.parse(NodeFS.readFileSync(configFile, "utf8"));
  if (mode !== "validate-prepared") {
    const stateFile = NodePath.join(NodePath.dirname(configFile), "activation-state.json");
    if (NodeFS.existsSync(stateFile)) {
      const state = JSON.parse(NodeFS.readFileSync(stateFile, "utf8"));
      config.windowsBackupRoot = state.windowsBackupRoot;
      config.wslBackupRoot = state.wslBackupRoot ?? config.wslBackupRoot;
      config.linkBaseline = state.linkBaseline;
    }
  }
  if (mode === "validate-prepared") {
    const prepared: PreparedUpdate = JSON.parse(
      NodeFS.readFileSync(NodePath.join(config.output, "prepared.json"), "utf8"),
    );
    assertPreparedUpdate(prepared, config.commit);
    if (config.updatePath !== prepared.updatePath) throw new Error("Prepared update path changed.");
    return { verified: true, commit: config.commit };
  }
  helperReceiptDirectory = NodePath.join(NodePath.dirname(configFile), "helpers");
  recordHelper(process.pid, `worker:${mode}`);
  if (
    mode === "capture-links" ||
    mode === "capture-links-windows" ||
    mode === "check-links" ||
    mode === "check-links-windows"
  ) {
    const windows = mode.endsWith("-windows");
    const userdata = windows
      ? (config.windowsUserdata ?? NodePath.join(NodeOS.homedir(), ".t3/userdata"))
      : NodePath.join(config.wslHome, "userdata");
    if (mode.startsWith("capture")) return captureLocalLinks(userdata);
    return checkLocalLink(
      userdata,
      windows ? config.linkBaseline.windows : config.linkBaseline.wsl,
      windows ? config.linkBaseline.wsl.environmentId : config.linkBaseline.windows.environmentId,
      Number(extra[0]),
      extra[1] === "descriptor-only",
    );
  }
  if (mode === "backup") {
    // WSL state stays on the Linux disk: writing it through /mnt/c timed out at 240 s for 3 GB.
    const destination = NodePath.join(config.wslBackupRoot, "backup-wsl");
    NodeFS.mkdirSync(config.wslBackupRoot, { mode: 0o700, recursive: true });
    const result = await backupState(
      NodePath.join(config.wslHome, "userdata"),
      destination,
      config.backupTimeoutMs,
      config.databaseBackup,
    );
    // Keep only this update's backup, matching the single Windows rollback.
    const parent = NodePath.dirname(config.wslBackupRoot);
    for (const entry of NodeFS.readdirSync(parent))
      if (
        /^[0-9a-f]{40}(?:-[0-9a-f-]{36})?$/.test(entry) &&
        entry !== NodePath.basename(config.wslBackupRoot)
      )
        NodeFS.rmSync(NodePath.join(parent, entry), { recursive: true, force: true });
    return result;
  }
  if (mode === "backup-windows")
    return backupState(
      config.windowsUserdata ?? NodePath.join(NodeOS.homedir(), ".t3/userdata"),
      NodePath.join(config.windowsBackupRoot, "backup-windows"),
      config.backupTimeoutMs,
    );
  if (mode === "install-runtime") {
    await run("bash", [NodePath.join(config.output, "runtime-install.sh")], {
      stdio: "pipe",
      timeout: 30_000,
      env: { ...process.env, HOME: NodePath.dirname(config.wslHome) },
    });
    return { installed: true, digest: config.digest };
  }
  if (mode === "stop-runtime")
    return stopLocalRuntime(config.wslHome, extra[0]!, config.environmentId);
  if (mode === "health") return runtimeHealth(config.wslHome, extra[0]!, config.environmentId);
  if (mode === "stopped") {
    try {
      NodeFS.statSync(`/proc/${extra[0]!}`);
      return { stopped: false };
    } catch {
      return { stopped: true };
    }
  }
  if (mode === "notify") {
    const current = await runtimeHealth(config.wslHome, extra[0]!);
    if (!current.healthy || !current.executable)
      throw new Error("No healthy runtime for notification");
    await run(
      current.executable,
      ["thread", "send", "--base-dir", config.wslHome, "--json", config.notifyThread, extra[1]!],
      { stdio: "pipe", timeout: 30000 },
    );
    return { sent: true };
  }
  if (mode === "native") {
    const { FileFinder } = await import(
      NodeURL.pathToFileURL(
        NodePath.join(
          extra[0]!,
          "resources/server.asar/node_modules/@ff-labs/fff-node/dist/index.js",
        ),
      ).href
    );
    const result = FileFinder.create({
      basePath: extra[1]!,
      frecencyDbPath: NodePath.join(extra[1]!, "frecency.mdb"),
      historyDbPath: NodePath.join(extra[1]!, "history.mdb"),
      disableWatch: true,
      disableMmapCache: true,
      disableContentIndexing: true,
    });
    if (!result.ok) throw new Error(result.error);
    result.value.destroy();
    return { nativeLoad: true };
  }
  throw new Error(`Unknown worker mode: ${mode}`);
}

function fileDigest(file: string) {
  const hash = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes: number;
    while ((bytes = NodeFS.readSync(descriptor, buffer)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

/** Hashes complete trees, including names, so additions and removals invalidate preparation. */
export function artifactDigests(paths: readonly string[]) {
  const visit = (file: string): string | null => {
    const stat = NodeFS.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) throw new Error(`Artifact contains a link: ${file}`);
    if (stat.isFile()) return fileDigest(file);
    if (!stat.isDirectory()) throw new Error(`Unsupported artifact: ${file}`);
    return buildCacheKey(
      NodeFS.readdirSync(file)
        .sort()
        .map((name) => [name, visit(NodePath.join(file, name))]),
    );
  };
  return Object.fromEntries(paths.map((file) => [file, visit(file)]));
}

/** Identifies build output by its source revision and external build inputs. */
export function buildCacheKey(inputs: unknown) {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

type PreparedUpdate = {
  schema: 2;
  commit: string;
  updatePath: string;
  cacheKey: string;
  files: Record<string, string | null>;
  artifacts: Record<string, string | null>;
  staged?: string | undefined;
  databaseBackup?: {
    required: boolean;
    reason: string;
    installedCommit?: string | undefined;
    candidateCommit: string;
  };
};

/** Refuses stale installations and incomplete or modified prepared files before activation. */
export function assertPreparedUpdate(prepared: PreparedUpdate, commit: string) {
  if (prepared.schema !== 2 || prepared.commit !== commit)
    throw new Error("Prepared commit no longer matches HEAD.");
  if (
    !prepared.files ||
    JSON.stringify(artifactDigests(Object.keys(prepared.files))) !== JSON.stringify(prepared.files)
  )
    throw new Error("Prepared content changed or is missing; prepare again.");
}

/** Finds intact build artifacts even when a later Windows staging attempt failed. */
export function findCachedBuild(root: string, cacheKey: string) {
  if (!NodeFS.existsSync(root)) return undefined;
  for (const name of NodeFS.readdirSync(root)) {
    const directory = NodePath.join(root, name);
    try {
      const cached: Pick<PreparedUpdate, "cacheKey" | "artifacts"> & { schema: 1 } = JSON.parse(
        NodeFS.readFileSync(NodePath.join(directory, "build-cache.json"), "utf8"),
      );
      if (
        cached.schema !== 1 ||
        cached.cacheKey !== cacheKey ||
        !cached.artifacts ||
        Object.values(cached.artifacts).some((digest) => !digest)
      )
        continue;
      if (
        JSON.stringify(artifactDigests(Object.keys(cached.artifacts))) ===
        JSON.stringify(cached.artifacts)
      )
        return directory;
    } catch {
      /* Incomplete or changed outputs cannot supply cached artifacts. */
    }
  }
  return undefined;
}

function linuxProcessStart(pid: number) {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() +
      ":" +
      stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[19]
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Removes an abandoned claim, preserving a live owner even when its PID has been reused. */
export async function preparedOutputIsActive(marker: string) {
  if (!NodeFS.existsSync(marker)) return false;
  const ownerFile = NodePath.join(marker, "owner.json");
  if (!NodeFS.existsSync(ownerFile)) {
    if (Date.now() - NodeFS.statSync(marker).mtimeMs < 30_000) return true;
  } else {
    let owner: { platform: string; pid: number; startTime: string } | undefined;
    try {
      owner = JSON.parse(NodeFS.readFileSync(ownerFile, "utf8"));
    } catch {
      if (Date.now() - NodeFS.statSync(marker).mtimeMs < 30_000) return true;
    }
    let start: string | null = null;
    if (owner?.platform === "linux") start = linuxProcessStart(owner.pid);
    else if (owner?.platform === "win32" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      const pid = owner.pid;
      start = await retryPreparationInterop(
        () =>
          run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks.ToString() }`,
            ],
            { stdio: "pipe", timeout: 15_000 },
          ),
        true,
      );
    } else if (owner) throw new Error(`Unknown prepared output owner: ${marker}`);
    if (start && start === owner?.startTime) return true;
  }
  console.warn(`Removing stale prepared output marker (owner exited): ${marker}`);
  NodeFS.rmSync(marker, { recursive: true });
  return false;
}

/** Claims an output until its owning process exits. */
export async function claimPreparedOutput(marker: string) {
  if (await preparedOutputIsActive(marker)) throw new Error(`Prepared output is active: ${marker}`);
  NodeFS.mkdirSync(marker);
  NodeFS.writeFileSync(
    NodePath.join(marker, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      platform: "linux",
      startTime: linuxProcessStart(process.pid),
    }),
  );
}

async function activatePrepared(output: string, commit: string, notifyThread?: string) {
  const prepared: PreparedUpdate = JSON.parse(
    NodeFS.readFileSync(NodePath.join(output, "prepared.json"), "utf8"),
  );
  if (prepared.schema !== 2 || prepared.commit !== commit)
    throw new Error("Prepared commit no longer matches HEAD.");
  const configFile = NodePath.join(output, "config.json");
  const config = JSON.parse(NodeFS.readFileSync(configFile, "utf8"));
  if (
    config.commit !== commit ||
    config.updatePath !== prepared.updatePath ||
    config.output !== output
  )
    throw new Error("Prepared configuration does not match its manifest.");
  const claim = NodePath.join(output, ".activation-claimed");
  await claimPreparedOutput(claim);
  helperReceiptDirectory = NodePath.join(output, "helpers");
  recordHelper(process.pid, "activation-driver");
  // Notification is an activation choice; the immutable prepared configuration stays sealed.
  if (notifyThread)
    NodeFS.writeFileSync(NodePath.join(output, "notify-thread"), notifyThread, { mode: 0o600 });
  const windowsPath = (file: string) => run("wslpath", ["-w", file], { stdio: "pipe" });
  try {
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      await windowsPath(NodePath.join(output, "activate.ps1")),
      "-ConfigPath",
      await windowsPath(configFile),
      "-Mode",
      "Launch",
    ]);
  } catch (error) {
    NodeFS.rmSync(claim, { recursive: true, force: true });
    throw error;
  }
  console.log(`Windows activation detached. Receipt: ${NodePath.join(output, "receipt.json")}`);
}

/** Prunes owned preparation outputs, preserving current work and retaining diagnostics. */
export async function prunePreparedOutputs(
  root: string,
  current: string,
  evidenceRoot = NodePath.join(NodeOS.homedir(), "evidence/t3code/prepared-installs"),
) {
  if (!NodeFS.existsSync(root)) return;
  const outputs = NodeFS.readdirSync(root)
    .map((name) => NodePath.join(root, name))
    .filter((directory) => {
      try {
        const config = JSON.parse(
          NodeFS.readFileSync(NodePath.join(directory, "config.json"), "utf8"),
        );
        return (
          config.output === directory &&
          ["full", "wsl-only"].includes(config.updatePath) &&
          ["prepared.json", "build-cache.json", ".preparation-active", ".activation-claimed"].some(
            (name) => NodeFS.existsSync(NodePath.join(directory, name)),
          )
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs);
  for (const [index, directory] of outputs.entries()) {
    if (directory === current) continue;
    const claim = NodePath.join(directory, ".activation-claimed");
    let claimed = false;
    try {
      const preparing = await preparedOutputIsActive(
        NodePath.join(directory, ".preparation-active"),
      );
      const activating = await preparedOutputIsActive(claim);
      if (preparing || activating || index < 3) continue;
      await claimPreparedOutput(claim);
      claimed = true;
      const config = JSON.parse(
        NodeFS.readFileSync(NodePath.join(directory, "config.json"), "utf8"),
      );
      if (config.updatePath === "full") {
        const windows = (file: string) => run("wslpath", ["-w", file], { stdio: "pipe" });
        await retryPreparationInterop(
          async () =>
            run(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                await windows(NodePath.join(directory, "activate.ps1")),
                "-ConfigPath",
                await windows(NodePath.join(directory, "config.json")),
                "-Mode",
                "Discard",
              ],
              { stdio: "pipe", timeout: 120_000 },
            ),
          true,
        );
      }
      const evidence = NodePath.join(evidenceRoot, NodePath.basename(directory));
      NodeFS.mkdirSync(evidence, { recursive: true, mode: 0o700 });
      for (const name of NodeFS.readdirSync(directory)) {
        if (
          ["current", "client", "windows", ".activation-claimed", "runtime-rollback"].includes(name)
        )
          continue;
        NodeFS.cpSync(NodePath.join(directory, name), NodePath.join(evidence, name), {
          recursive: true,
        });
      }
      NodeFS.rmSync(directory, { recursive: true });
    } catch (error) {
      console.warn(`Could not prune prepared output ${directory}: ${String(error)}`);
    } finally {
      if (claimed) NodeFS.rmSync(claim, { recursive: true, force: true });
    }
  }
}

async function main() {
  const prepareStarted = Date.now();
  const { values, tokens } = NodeUtil.parseArgs({
    tokens: true,
    options: {
      "install-dir": { type: "string" },
      "output-dir": { type: "string" },
      "vp-home": { type: "string", default: process.env.VP_HOME },
      "patchelf-dir": { type: "string" },
      "linux-monitor-dir": { type: "string" },
      "windows-monitor": { type: "string" },
      "wsl-distro": { type: "string", default: process.env.WSL_DISTRO_NAME },
      "wsl-home": { type: "string", default: NodePath.join(NodeOS.homedir(), ".t3") },
      "health-seconds": { type: "string", default: "240" },
      "notify-thread": { type: "string" },
      full: { type: "boolean" },
      "wsl-only": { type: "boolean" },
      "plan-only": { type: "boolean" },
      "installed-receipt": { type: "string" },
      "prepare-only": { type: "boolean" },
      activate: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(`Usage: vp run desktop:update-local --install-dir 'C:\\...\\Weavewing' --output-dir /absolute/evidence/run
  --vp-home PATH               Vite Plus home (or VP_HOME), with current/bin/vp
  --patchelf-dir PATH          Directory containing patchelf (otherwise PATH)
  --linux-monitor-dir PATH        Release resource-monitor directory, with a source-tag file naming that release tag
  --windows-monitor PATH      Matching release's Windows x64 monitor executable
  --wsl-distro NAME           WSL distribution (or WSL_DISTRO_NAME)
  --wsl-home PATH             Installed T3 home (default ~/.t3)
  --health-seconds N          Runtime health deadline (default 240; non-migrating WSL-only capped at 45)
  --notify-thread ID          Send the activation result after restart
  --full / --wsl-only        Force shell replacement / runtime-only update
  --plan-only                Report selection without building or Windows interop
  --installed-receipt PATH   Receipt to read instead of <install-dir>/.weavewing-local-update.json
  --prepare-only             Build, smoke-test and stage without changing the install
  --activate PATH            Activate a prepared output directory without rebuilding`);
    return;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone WSL driver runs without an Effect runtime.
  if (NodeOS.platform() !== "linux")
    throw new Error("Run this command inside WSL with Windows interop enabled.");
  const repo = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
  const git = (...args: string[]) => run("git", ["-C", repo, ...args], { stdio: "pipe" });
  if (values.activate) {
    if (
      tokens.some(
        (token) => token.kind === "option" && !["activate", "notify-thread"].includes(token.name),
      )
    )
      throw new Error("--activate accepts only a prepared directory and --notify-thread.");
    if (await git("status", "--porcelain"))
      throw new Error("Activation requires a clean checkout.");
    await activatePrepared(
      NodePath.resolve(values.activate),
      await git("rev-parse", "HEAD"),
      values["notify-thread"],
    );
    return;
  }
  if (values.full && values["wsl-only"])
    throw new Error("Choose only one of --full and --wsl-only.");
  const force = values.full ? "full" : values["wsl-only"] ? "wsl-only" : undefined;
  const installedFile = await installedReceiptPath(values, (path) =>
    run("wslpath", ["-u", path], { stdio: "pipe" }),
  );
  let installed: {
    commit?: string;
    shellCommit?: string;
    clientCommit?: string;
    clientAssetsDirectory?: string;
    digest?: string;
    exeHash?: string;
    shellHash?: string;
  } = {};
  let receiptStatus = "no receipt: pass --install-dir or --installed-receipt";
  if (installedFile) {
    receiptStatus = `unreadable or invalid receipt: ${installedFile}`;
    try {
      const receipt = JSON.parse(NodeFS.readFileSync(installedFile, "utf8"));
      if (
        receipt &&
        typeof receipt === "object" &&
        typeof receipt.shellCommit === "string" &&
        typeof receipt.shellHash === "string"
      ) {
        installed = receipt;
        receiptStatus = `read ${installedFile}`;
      }
    } catch {
      /* Missing provenance requires the full path. */
    }
  }
  let changed: string[] = [];
  if (installed.shellCommit) {
    try {
      await git("merge-base", "--is-ancestor", installed.shellCommit, "HEAD");
      changed = (await git("diff", "--no-renames", "--name-only", installed.shellCommit, "HEAD"))
        .split("\n")
        .filter(Boolean);
    } catch {
      installed = {};
    }
  }
  if (!values["plan-only"] && installedFile && installed.shellHash) {
    const installRoot = NodePath.dirname(installedFile);
    try {
      const hash = (file: string) =>
        NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(NodePath.join(installRoot, file)))
          .digest("hex");
      if (
        hash("resources/app.asar") !== installed.shellHash ||
        hash("Weavewing.exe") !== installed.exeHash
      )
        installed = {};
    } catch {
      installed = {};
    }
  }
  if (force === "wsl-only" && installed.clientAssetsDirectory !== "resources/client")
    throw new Error("Installed shell cannot refresh loose client assets; run --full once first.");
  const updatePath = selectUpdatePath(
    installed.shellHash && installed.clientAssetsDirectory === "resources/client"
      ? installed.shellCommit
      : undefined,
    force,
    changed,
  );
  if (values["plan-only"]) {
    console.log(
      JSON.stringify(
        {
          updatePath,
          receipt: receiptStatus,
          shellCommit: installed.shellCommit,
          clientCommit: installed.clientCommit,
          changed,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (await git("status", "--porcelain"))
    throw new Error(
      "Commit or remove worktree changes before updating; the build requires a clean tree.",
    );
  for (const name of [
    "install-dir",
    "output-dir",
    "vp-home",
    "linux-monitor-dir",
    "wsl-distro",
  ] as const) {
    if (!values[name]) throw new Error(`Missing --${name}. See --help.`);
  }
  if (updatePath === "full" && !values["windows-monitor"])
    throw new Error("Missing --windows-monitor for full update.");
  if (NodePath.basename(values["wsl-home"]!) !== ".t3")
    throw new Error("--wsl-home must end in .t3 (the desktop runtime contract).");
  const output = values["output-dir"]!;
  if (!NodePath.isAbsolute(output) || NodeFS.existsSync(output))
    throw new Error(
      "--output-dir must be a new absolute directory, outside the installation and candidate.",
    );
  const outputWindows = (await run("wslpath", ["-w", output], { stdio: "pipe" })).toLowerCase();
  const install = NodePath.win32.resolve(values["install-dir"]!);
  const parent = NodePath.win32.dirname(install);
  const name = NodePath.win32.basename(install);
  for (const protectedPath of [
    install,
    NodePath.win32.join(parent, `.${name}-candidate`),
    NodePath.win32.join(parent, `.${name}-local-update-rollback`),
    NodePath.win32.join(parent, `.${name}-local-update-state`),
  ]) {
    const relative = NodePath.win32.relative(protectedPath.toLowerCase(), outputWindows);
    if (
      !relative ||
      (!relative.startsWith("..\\") && relative !== ".." && !NodePath.win32.isAbsolute(relative))
    )
      throw new Error(`--output-dir must be outside ${protectedPath}.`);
  }
  const stateRelative = NodePath.relative(NodePath.join(values["wsl-home"]!, "userdata"), output);
  if (
    !stateRelative ||
    (!stateRelative.startsWith(`..${NodePath.sep}`) &&
      stateRelative !== ".." &&
      !NodePath.isAbsolute(stateRelative))
  )
    throw new Error("--output-dir must be outside the installed WSL userdata directory.");
  const vpHome = values["vp-home"]!;
  const vp = NodePath.join(vpHome, "current/bin/vp");
  for (const file of [
    vp,
    NodePath.join(values["linux-monitor-dir"]!, "linux-x64/t3-resource-monitor"),
    ...(updatePath === "full" ? [values["windows-monitor"]!] : []),
  ]) {
    if (!NodeFS.statSync(file, { throwIfNoEntry: false })?.isFile())
      throw new Error(`Required toolchain file is missing: ${file}`);
  }
  const healthSeconds = Number(values["health-seconds"]);
  if (!Number.isFinite(healthSeconds) || healthSeconds <= 0)
    throw new Error("Health deadline must be positive.");
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(repo, "package.json"), "utf8"));
  if (process.versions.node !== manifest.engines.node)
    throw new Error(`Run with Node ${manifest.engines.node}; found ${process.versions.node}.`);
  const version = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repo, "apps/server/package.json"), "utf8"),
  ).version;
  if (updatePath === "wsl-only")
    await assertShellVersion(
      () => git("show", `${installed.shellCommit}:apps/server/package.json`),
      version,
    );
  const monitorTagFile = NodePath.join(values["linux-monitor-dir"]!, "source-tag");
  const monitorTag = NodeFS.readFileSync(monitorTagFile, "utf8").trim();
  if (!/^v\d[\w.+-]*$/.test(monitorTag))
    throw new Error(`${monitorTagFile} must contain the release tag the monitors came from.`);
  await git("rev-parse", "--verify", "--quiet", `refs/tags/${monitorTag}^{commit}`);
  await git("diff", "--exit-code", `refs/tags/${monitorTag}`, "--", "native/resource-monitor");
  NodeFS.mkdirSync(output, { mode: 0o700, recursive: true });
  helperReceiptDirectory = NodePath.join(output, "helpers");
  recordHelper(process.pid, "driver");
  const backupRoot = await run(
    "wslpath",
    ["-u", NodePath.win32.join(parent, `.${name}-local-update-state`)],
    {
      stdio: "pipe",
    },
  );
  const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "weavewing-update-bin-"));
  await claimPreparedOutput(NodePath.join(output, ".preparation-active"));
  try {
    for (const name of ["vp", "vpr", "vpx", "node", "yarn", "yarnpkg", "bun", "bunx"])
      NodeFS.symlinkSync(vp, NodePath.join(bin, name));
    const env = {
      ...localDesktopBuildEnvironment(process.env),
      VP_HOME: vpHome,
      VP_NODE_VERSION: manifest.engines.node,
      PATH: [bin, values["patchelf-dir"], NodePath.join(vpHome, "fallback-bin"), process.env.PATH]
        .filter(Boolean)
        .join(NodePath.delimiter),
      T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
    };
    const buildTimings: Array<{ command: string; milliseconds: number }> = [];
    const build = async (command: string, args: string[], cwd = repo) => {
      const started = Date.now();
      try {
        return await run(command, args, { cwd, env });
      } finally {
        buildTimings.push({
          command: [command, ...args].join(" "),
          milliseconds: Date.now() - started,
        });
        NodeFS.writeFileSync(
          NodePath.join(output, "build-timings.json"),
          JSON.stringify(buildTimings, null, 2),
        );
      }
    };
    await build("patchelf", ["--version"]);
    await build("vp", ["--version"]);
    const powershell = (args: string[]) =>
      retryPreparationInterop(() =>
        run(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
          { stdio: "pipe", timeout: 300_000 },
        ),
      ).then((result) => {
        if (result) console.log(result);
      });
    const windowsPath = (file: string) => run("wslpath", ["-w", file], { stdio: "pipe" });
    const activation = NodePath.join(output, "activate.ps1");
    NodeFS.copyFileSync(NodePath.join(repo, "scripts/activate-local-desktop.ps1"), activation);
    NodeFS.copyFileSync(
      NodePath.join(repo, "scripts/stage-windows-desktop.ps1"),
      NodePath.join(output, "stage-windows-desktop.ps1"),
    );
    NodeFS.writeFileSync(
      NodePath.join(output, "worker.mjs"),
      NodeModule.stripTypeScriptTypes(
        NodeFS.readFileSync(NodeURL.fileURLToPath(import.meta.url), "utf8"),
      ),
    );
    const candidateName = `.${name}-prepared-${NodeCrypto.createHash("sha256").update(output).digest("hex").slice(0, 16)}`;
    const candidate = NodePath.win32.join(parent, candidateName);
    const config = {
      output,
      candidate,
      updatePath,
      databaseBackup: await databaseBackupDecision(
        git,
        installed.commit,
        await git("rev-parse", "HEAD"),
      ),
      shellCommit: updatePath === "full" ? await git("rev-parse", "HEAD") : installed.shellCommit,
      clientCommit: await git("rev-parse", "HEAD"),
      clientAssetsDirectory: "resources/client",
      clientSource: await windowsPath(NodePath.join(output, "client")),
      previousDigest: installed.digest,
      environmentId: NodeFS.readFileSync(
        NodePath.join(values["wsl-home"]!, "userdata/environment-id"),
        "utf8",
      ).trim(),
      commit: await git("rev-parse", "HEAD"),
      install: values["install-dir"],
      distro: values["wsl-distro"],
      wslHome: values["wsl-home"],
      node: process.execPath,
      healthSeconds: updatePath === "wsl-only" ? Math.min(45, healthSeconds) : healthSeconds,
      backupRoot,
      backupRootWindows: await windowsPath(backupRoot),
      wslBackupRoot: NodePath.join(
        NodeOS.homedir(),
        ".local/share/weavewing-update-backups",
        await git("rev-parse", "HEAD"),
      ),
      notifyThread: values["notify-thread"],
      source: await windowsPath(NodePath.join(output, "windows/win-unpacked")),
      digest: "",
      exeHash: updatePath === "wsl-only" ? (installed.exeHash ?? "") : "",
      shellHash: updatePath === "wsl-only" ? (installed.shellHash ?? "") : "",
      archive: "",
    };
    const configFile = NodePath.join(output, "config.json");
    const saveConfig = () =>
      NodeFS.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    saveConfig();
    await powershell([
      "-File",
      await windowsPath(activation),
      "-ConfigPath",
      await windowsPath(configFile),
      "-Mode",
      "Preflight",
    ]);
    if (!NodeFS.existsSync(NodePath.join(repo, "node_modules"))) await build("vp", ["i"]);
    const commit = config.commit;
    const cacheKey = buildCacheKey({
      commit,
      updatePath,
      node: process.versions.node,
      environment: localDesktopBuildEnvironment({}),
      installation: localBuildInstallIdentity(repo),
      vp: await build("vp", ["--version"]),
      monitorTag,
      tools: artifactDigests([
        vp,
        NodePath.join(
          values["patchelf-dir"] ??
            NodePath.dirname(await run("which", ["patchelf"], { stdio: "pipe" })),
          "patchelf",
        ),
        NodePath.join(values["linux-monitor-dir"]!, "linux-x64/t3-resource-monitor"),
        ...(updatePath === "full" ? [values["windows-monitor"]!] : []),
      ]),
    });
    const buildsRoot = NodePath.join(NodeOS.homedir(), ".local/share/weavewing-builds");
    const cacheSource = findCachedBuild(buildsRoot, cacheKey);
    const archive = NodePath.join(output, "current", `t3-${version}-linux-x64.tar.gz`);
    if (cacheSource) {
      for (const name of ["current", "client", ...(updatePath === "full" ? ["windows"] : [])])
        NodeFS.cpSync(NodePath.join(cacheSource, name), NodePath.join(output, name), {
          recursive: true,
        });
      console.log(`Reusing verified build output from ${cacheSource}`);
    } else {
      await build("vp", ["run", "--filter", "t3", "build"]);
      if (updatePath === "full") {
        const windowsMonitor = NodePath.join(
          repo,
          "native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe",
        );
        NodeFS.mkdirSync(NodePath.dirname(windowsMonitor), { recursive: true });
        NodeFS.copyFileSync(values["windows-monitor"]!, windowsMonitor);
        await build("node", ["apps/desktop/scripts/build-preview-annotation-css.mjs"]);
        await build("vp", ["pack"], NodePath.join(repo, "apps/desktop"));
      }
      await build("node", ["apps/server/scripts/cli.ts", "build-exe", "--verbose"]);
      await build("node", [
        "scripts/build-cli-archive.ts",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        version,
        "--resource-monitor-dir",
        values["linux-monitor-dir"]!,
        "--output-dir",
        NodePath.join(output, "current"),
      ]);
      if (updatePath === "full") {
        await build("node", [
          "scripts/build-desktop-artifact.ts",
          "--platform",
          "win",
          "--target",
          "dir",
          "--arch",
          "x64",
          "--build-version",
          version,
          "--skip-build",
          "--wsl-runtime",
          archive,
          "--output-dir",
          NodePath.join(output, "windows"),
          "--verbose",
        ]);
      }
      NodeFS.cpSync(
        NodePath.join(repo, "apps/server/dist/client"),
        NodePath.join(output, "client"),
        {
          recursive: true,
        },
      );
      // DesktopEnvironment serves the loose client only while this matches the running shell.
      NodeFS.writeFileSync(NodePath.join(output, "client/.shell-version"), version);
      if (updatePath === "full")
        NodeFS.cpSync(
          NodePath.join(output, "client"),
          NodePath.join(output, "windows/win-unpacked/resources/client"),
          {
            recursive: true,
          },
        );
    }
    await build("node", [
      "scripts/smoke-cli-archive.ts",
      "--archive",
      archive,
      "--expect-version",
      version,
    ]);
    const artifacts = artifactDigests([
      NodePath.join(output, "current"),
      NodePath.join(output, "client"),
      ...(updatePath === "full" ? [NodePath.join(output, "windows")] : []),
    ]);
    if ((await git("status", "--porcelain")) || config.commit !== (await git("rev-parse", "HEAD")))
      throw new Error("Source changed during the build; refusing to cache artifacts.");
    NodeFS.writeFileSync(
      NodePath.join(output, "build-cache.json"),
      JSON.stringify({ schema: 1, commit, cacheKey, artifacts }, null, 2),
      { mode: 0o600 },
    );
    const hash = fileDigest;
    config.digest = hash(archive);
    config.archive = await windowsPath(archive);
    if (updatePath === "full") {
      config.exeHash = hash(NodePath.join(output, "windows/win-unpacked/Weavewing.exe"));
      config.shellHash = hash(NodePath.join(output, "windows/win-unpacked/resources/app.asar"));
    }
    const { buildWslRuntimeInstallScript } = await import(
      new URL("../apps/desktop/src/wsl/DesktopWslEnvironment.ts", import.meta.url).href
    );
    NodeFS.writeFileSync(
      NodePath.join(output, "runtime-install.sh"),
      buildWslRuntimeInstallScript(archive, `sha256-${config.digest}`, config.digest),
    );
    saveConfig();
    await powershell([
      "-File",
      await windowsPath(activation),
      "-ConfigPath",
      await windowsPath(configFile),
      "-Mode",
      "Prepare",
    ]);
    if ((await git("status", "--porcelain")) || config.commit !== (await git("rev-parse", "HEAD")))
      throw new Error("Source changed during the build; refusing preparation.");
    const prepared: PreparedUpdate = {
      schema: 2,
      commit,
      updatePath,
      cacheKey,
      artifacts,
      databaseBackup: config.databaseBackup,
      staged: updatePath === "full" ? NodePath.win32.join(candidate, "payload") : undefined,
      files: artifactDigests([
        ...Object.keys(artifacts),
        activation,
        configFile,
        NodePath.join(output, "installed-digests.json"),
        NodePath.join(output, "worker.mjs"),
        NodePath.join(output, "stage-windows-desktop.ps1"),
        NodePath.join(output, "runtime-install.sh"),
        ...(updatePath === "full" ? [NodePath.join(output, "staged-digests.json")] : []),
      ]),
    };
    if (Object.values(prepared.files).some((digest) => !digest))
      throw new Error("Prepared artifact missing.");
    assertPreparedUpdate(prepared, commit);
    NodeFS.writeFileSync(
      NodePath.join(output, "prepared.json"),
      JSON.stringify(prepared, null, 2),
      { mode: 0o600 },
    );
    NodeFS.writeFileSync(
      NodePath.join(output, "prepare-timing.json"),
      JSON.stringify(
        { milliseconds: Date.now() - prepareStarted, cacheSource: cacheSource ?? null },
        null,
        2,
      ),
    );
    console.log(
      `Prepared ${commit} (${updatePath}) in ${((Date.now() - prepareStarted) / 1000).toFixed(1)}s. Activate with --activate ${output}`,
    );
    await prunePreparedOutputs(buildsRoot, output);
    if (!values["prepare-only"]) await activatePrepared(output, commit, values["notify-thread"]);
  } finally {
    NodeFS.rmSync(bin, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.join(output, ".preparation-active"), { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
)
  try {
    if (process.argv[2] === "--snapshot") {
      helperReceiptDirectory = process.argv[5]!;
      recordHelper(process.pid, "sqlite-snapshot");
      await snapshot(process.argv[3]!, process.argv[4]!);
    } else if (process.argv[2] === "--worker")
      console.log(
        JSON.stringify(await worker(process.argv[3]!, process.argv[4]!, process.argv.slice(5))),
      );
    else await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
