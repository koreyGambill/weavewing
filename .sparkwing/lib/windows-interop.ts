import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

const startupTimeout = /^(?:<3>WSL \(\d+ - \) ERROR: )?UtilAcceptVsock:281: accept4 failed 110\r?\n?$/;

/** Select a listening WSL interop socket without opening a connection to its relay. */
export function windowsInterop(inherited?: string, directory = "/run/WSL", owner = 0) {
  const dir = lstatSync(directory, { throwIfNoEntry: false });
  if (!dir?.isDirectory() || dir.uid !== owner || (dir.mode & 0o022) !== 0) return;
  const listeners = new Set<string>();
  for (const line of readFileSync("/proc/net/unix", "utf8").split("\n")) {
    const [, , , flags, type, state, , path] = line.trim().split(/\s+/);
    if (flags === "00010000" && type === "0001" && state === "01" && path &&
        dirname(path) === directory && /^\d+_interop$/.test(basename(path)))
      listeners.add(path);
  }
  const ownedSocket = (path: string) => {
    const socket = lstatSync(path, { throwIfNoEntry: false });
    return socket?.isSocket() && socket.uid === owner;
  };
  if (inherited && dirname(inherited) === directory && /^\d+_interop$/.test(basename(inherited))) {
    // WSL can publish its default interop socket through a symlink.
    try {
      const target = realpathSync(inherited);
      if (listeners.has(target) && ownedSocket(target)) return inherited;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return [...listeners].find(ownedSocket);
}

/** Run a PowerShell smoke script, retrying only the known pre-execution WSL timeout. */
export async function runWindowsSmoke(script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  for (const backoff of [250, 500, 0]) {
    const env = { ...process.env, WSL_INTEROP: windowsInterop(process.env.WSL_INTEROP) };
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutSeen = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSeen = true;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      process.stderr.write(chunk);
      if (stderr.length < 256) stderr += chunk.slice(0, 256 - stderr.length);
    });
    const [status, signal] = await once(child, "close").catch((error: NodeJS.ErrnoException) => {
      throw new Error(`Cannot launch powershell.exe (${error.code ?? "unknown error"})`);
    });
    if (status === 0) return;
    if (!backoff || signal || stdoutSeen || !startupTimeout.test(stderr))
      throw new Error(`Windows smoke failed (${signal ?? `exit ${status}`})`);
    console.error(`WSL interop startup timed out. Retrying Windows smoke in ${backoff} ms.`);
    await setTimeout(backoff);
  }
}
