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

const activeStatuses = ["preparing", "queued", "starting", "running"];
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

async function backupState(source: string, destination: string, timeout = 240_000) {
  NodeFS.mkdirSync(destination, { mode: 0o700 });
  try {
    const database = NodePath.join(source, "statev2.sqlite");
    if (NodeFS.existsSync(database)) {
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
    return { backedUp: true, path: destination };
  } catch (error) {
    NodeFS.rmSync(destination, { recursive: true, force: true });
    throw error;
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

async function readThreads(
  endpoint: string,
  authorization: string,
  deadline: number,
  peer = false,
) {
  const requestSignal = () => {
    if (Date.now() >= deadline) throw new Error("MCP health deadline expired");
    return AbortSignal.timeout(Math.max(1, Math.min(5000, Math.floor(deadline - Date.now()))));
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization,
    ...(peer ? { "T3-Mode-Limit": "approval-required/plan" } : {}),
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
          statuses: activeStatuses,
          limit: 1,
        },
      },
    });
    if (result?.isError || !Number.isInteger(result?.structuredContent?.total))
      throw new Error("MCP returned no thread count");
    return {
      idle: result.structuredContent.total === 0,
      active: result.structuredContent.total,
      source: "mcp",
    };
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

async function idle(home: string, authorizationFile?: string) {
  if (authorizationFile) {
    const runtime = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, "userdata/server-runtime.json"), "utf8"),
    );
    const authorization = NodeFS.readFileSync(authorizationFile, "utf8").trim();
    return readThreads(`http://127.0.0.1:${runtime.port}/mcp`, authorization, Date.now() + 20_000);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(NodePath.join(home, "userdata/statev2.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE status IN (${activeStatuses.map(() => "?").join(",")})`,
      )
      .get(...activeStatuses);
    return { idle: row?.count === 0, active: Number(row?.count), source: "read-only-sqlite" };
  } finally {
    db.close();
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
    await readThreads(`${result.url}/mcp`, `Bearer ${token}`, deadline, true);
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
    );
    if (!config.checkOnly) {
      // Keep only this update's backup, matching the single Windows rollback.
      const parent = NodePath.dirname(config.wslBackupRoot);
      for (const entry of NodeFS.readdirSync(parent))
        if (
          /^[0-9a-f]{40}(?:-[0-9a-f-]{36})?$/.test(entry) &&
          entry !== NodePath.basename(config.wslBackupRoot)
        )
          NodeFS.rmSync(NodePath.join(parent, entry), { recursive: true, force: true });
    }
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
  if (mode === "stop-runtime") {
    const current = await runtimeHealth(config.wslHome, extra[0]!, config.environmentId);
    if (!current.executable || !current.pid)
      throw new Error("Runtime identity changed; refusing to stop it.");
    process.kill(current.pid, "SIGTERM");
    return { stopped: true, pid: current.pid };
  }
  if (mode === "idle") return idle(config.wslHome, config.authorizationFile);
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

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      "install-dir": { type: "string" },
      "output-dir": { type: "string" },
      "vp-home": { type: "string", default: process.env.VP_HOME },
      "patchelf-dir": { type: "string" },
      "linux-monitor-dir": { type: "string" },
      "windows-monitor": { type: "string" },
      "wsl-distro": { type: "string", default: process.env.WSL_DISTRO_NAME },
      "wsl-home": { type: "string", default: NodePath.join(NodeOS.homedir(), ".t3") },
      "drain-minutes": { type: "string", default: "5" },
      "health-seconds": { type: "string", default: "240" },
      "notify-thread": { type: "string" },
      "mcp-authorization-file": { type: "string" },
      full: { type: "boolean" },
      "wsl-only": { type: "boolean" },
      "plan-only": { type: "boolean" },
      "installed-receipt": { type: "string" },
      "check-only": { type: "boolean" },
      "dry-run": { type: "boolean" },
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
  --drain-minutes N           Wait for active turns, then proceed (default 5, 0 skips)
  --health-seconds N          Runtime health deadline (default 240; non-migrating WSL-only capped at 45)
  --mcp-authorization-file PATH  File containing an MCP Authorization header
  --notify-thread ID          Send the activation result after restart
  --full / --wsl-only        Force shell replacement / runtime-only update
  --plan-only                Report selection without building or Windows interop
  --installed-receipt PATH   Receipt to read instead of <install-dir>/.weavewing-local-update.json
  --check-only, --dry-run     Build, verify, stage, drain and back up; leave install running`);
    return;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone WSL driver runs without an Effect runtime.
  if (NodeOS.platform() !== "linux")
    throw new Error("Run this command inside WSL with Windows interop enabled.");
  const repo = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
  const git = (...args: string[]) => run("git", ["-C", repo, ...args], { stdio: "pipe" });
  if (values.full && values["wsl-only"])
    throw new Error("Choose only one of --full and --wsl-only.");
  const force = values.full ? "full" : values["wsl-only"] ? "wsl-only" : undefined;
  const installedFile = await installedReceiptPath(values, (path) =>
    run("wslpath", ["-u", path], { stdio: "pipe" }),
  );
  let installed: {
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
  const drainMinutes = Number(values["drain-minutes"]);
  const healthSeconds = Number(values["health-seconds"]);
  if (
    !Number.isFinite(drainMinutes) ||
    drainMinutes < 0 ||
    !Number.isFinite(healthSeconds) ||
    healthSeconds <= 0
  )
    throw new Error("Drain must be nonnegative and health deadline must be positive.");
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
  const checkOnly = !!(values["check-only"] || values["dry-run"]);
  const backupRoot = checkOnly
    ? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "weavewing-backups-"))
    : await run("wslpath", ["-u", NodePath.win32.join(parent, `.${name}-local-update-state`)], {
        stdio: "pipe",
      });
  const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "weavewing-update-bin-"));
  try {
    for (const name of ["vp", "vpr", "vpx", "node", "yarn", "yarnpkg", "bun", "bunx"])
      NodeFS.symlinkSync(vp, NodePath.join(bin, name));
    const env = {
      ...process.env,
      VP_HOME: vpHome,
      VP_NODE_VERSION: manifest.engines.node,
      PATH: [bin, values["patchelf-dir"], NodePath.join(vpHome, "fallback-bin"), process.env.PATH]
        .filter(Boolean)
        .join(NodePath.delimiter),
      T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
      T3CODE_DESKTOP_UPDATE_REPOSITORY: "koreyGambill/t3code",
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
      run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
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
    const config = {
      output,
      updatePath,
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
      drainMinutes,
      healthSeconds: updatePath === "wsl-only" ? Math.min(45, healthSeconds) : healthSeconds,
      checkOnly,
      backupRoot,
      backupRootWindows: await windowsPath(backupRoot),
      wslBackupRoot: checkOnly
        ? backupRoot
        : NodePath.join(
            NodeOS.homedir(),
            ".local/share/weavewing-update-backups",
            `${await git("rev-parse", "HEAD")}-${NodeCrypto.randomUUID()}`,
          ),
      notifyThread: values["notify-thread"],
      authorizationFile: values["mcp-authorization-file"],
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
    const archive = NodePath.join(output, "current", `t3-${version}-linux-x64.tar.gz`);
    await build("node", [
      "scripts/smoke-cli-archive.ts",
      "--archive",
      archive,
      "--expect-version",
      version,
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
    NodeFS.cpSync(NodePath.join(repo, "apps/server/dist/client"), NodePath.join(output, "client"), {
      recursive: true,
    });
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
    const hash = (file: string) =>
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
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
    if ((await git("status", "--porcelain")) || config.commit !== (await git("rev-parse", "HEAD")))
      throw new Error("Source changed during the build; refusing activation.");
    if (updatePath === "full")
      await powershell([
        "-File",
        await windowsPath(activation),
        "-ConfigPath",
        await windowsPath(configFile),
        "-Mode",
        "Prepare",
      ]);
    await powershell([
      "-File",
      await windowsPath(activation),
      "-ConfigPath",
      await windowsPath(configFile),
      "-Mode",
      config.checkOnly ? "Activate" : "Launch",
    ]);
    console.log(
      `${config.checkOnly ? "Check complete" : "Windows activation detached"}. Receipt: ${NodePath.join(output, "receipt.json")}`,
    );
    if (!config.checkOnly)
      console.log(
        `Inspect receipt.json and activation.log in ${output}; detached.stderr captures PowerShell startup errors.`,
      );
  } finally {
    NodeFS.rmSync(bin, { recursive: true, force: true });
    if (checkOnly) NodeFS.rmSync(backupRoot, { recursive: true, force: true });
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
