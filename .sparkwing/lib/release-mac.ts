import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { parseArgs } from "node:util";

import { assertNoNodeTracing } from "./release-mac-signing.ts";
import { APPLE_SIGNING_SECRETS, macCleanup, macHost, macStartup, normalizeArtifacts, recordMacSigning, releaseInputs } from "./release.ts";

assertNoNodeTracing(process.env);
const { values } = parseArgs({ options: Object.fromEntries(["worktree", "commit", "version", "channel", "run", "evidence", "host"].map((name) => [name, { type: "string" as const }])) });
const { worktree, commit, version, run: runId, evidence } = values;
if (!worktree || !commit || !version || !runId || !evidence || !/^[a-zA-Z0-9_-]+$/.test(runId) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid Mac build inputs");
const { channel } = releaseInputs(version, "mac", values.channel);
const host = macHost(values.host);
const remote = `weavewing-release/${runId}`;
const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host];
const run = (command: string, args: string[], input?: string) => CP.execFileSync(command, args, { input, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"], maxBuffer: 1024 * 1024 });
const present = APPLE_SIGNING_SECRETS.filter((name) => process.env[name]);
if (present.length && present.length !== APPLE_SIGNING_SECRETS.length) throw new Error("Apple signing is partially configured. Supply all six secrets or none.");
// The remote process owns the marker until it finishes, even if the local ssh is gone.
const markProcess = `set -eu; root="$HOME/${remote}"; test -d "$root/source"; printf '%s\\n' "$$" > "$root/build.pid.tmp"; mv "$root/build.pid.tmp" "$root/build.pid";`;
let failure: unknown;
let buildMayRun = false;
try {
  run("ssh", [...ssh, "sh -s"], macStartup(runId));
  const archive = CP.spawn("git", ["-C", worktree, "archive", commit], { stdio: ["ignore", "pipe", "inherit"] });
  const extract = CP.spawn("ssh", [...ssh, `${markProcess}
trap 'rm -R "$root/source"' EXIT
trap 'exit 1' HUP INT TERM
tar -x -C "$root/source"
trap - EXIT`], { stdio: ["pipe", "inherit", "inherit"] });
  extract.stdin.on("error", () => archive.stdout.destroy());
  archive.stdout.pipe(extract.stdin);
  const exited = (child: CP.ChildProcess) => new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Source transfer exited ${code}`)));
  });
  const transfer = await Promise.allSettled([exited(archive), exited(extract)]);
  for (const result of transfer) if (result.status === "rejected") throw result.reason;
  // The remote helper reads the JSON payload on stdin; secrets never become ssh arguments.
  const nodeVersion = JSON.parse(CP.execFileSync("git", ["-C", worktree, "show", `${commit}:package.json`], { encoding: "utf8" })).engines.node;
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error("Invalid managed Node version");
  try {
    run("ssh", [...ssh, `${markProcess} vpPath=$(env sh -c 'command -v vp'); node="$(dirname "$(dirname "$vpPath")")/js_runtime/node/${nodeVersion}/bin/node"; exec env -u NODE_DEBUG -u NODE_DEBUG_NATIVE -u NODE_OPTIONS -C ~/${remote}/source "$node" .sparkwing/lib/release-mac-build.ts "${runId}"`], JSON.stringify({ version, channel, secrets: Object.fromEntries(APPLE_SIGNING_SECRETS.map((name) => [name, process.env[name] ?? ""])) }));
  } catch (error) {
    // ssh exits 255 for its own failures; only then may the Mac build outlive the connection.
    const status = (error as { status?: number | null }).status;
    buildMayRun = status === 255 || status === null;
    throw error;
  }
} catch (error) {
  failure = error;
}
if (buildMayRun)
  throw new Error(`Lost the SSH connection to ${host} while the Mac build may still be running. The remote build removes its credentials and source when it exits. The next run can reclaim ~/${remote} after its process exits.`, { cause: failure });
try {
  FS.mkdirSync(Path.join(evidence, "assets"), { recursive: true });
  run("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `${host}:${remote}/assets/*`, Path.join(evidence, "assets/")]);
  normalizeArtifacts(Path.join(evidence, "assets"), "mac", version, channel);
  FS.rmSync(Path.join(evidence, "mac-proof.json"), { force: true });
  for (const file of ["mac-proof.json", "mac-gatekeeper.txt"])
    if (CP.spawnSync("ssh", [...ssh, `test -f ~/${remote}/${file}`], { stdio: "ignore" }).status === 0)
      run("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `${host}:${remote}/${file}`, Path.join(evidence, file)]);
  // A successful build must leave a proof covering the copied bytes; drafts look its result up by their hashes.
  if (!failure) console.log(`macOS signing: ${recordMacSigning(Path.join(evidence, "mac-proof.json"), Path.join(evidence, "assets"), version)}`);
} catch (error) {
  failure ??= error;
}
try {
  run("ssh", [...ssh, macCleanup(runId)]);
} catch (error) {
  if (!failure) throw error;
  // The next run's startup sweeps the directory, but a failed removal must not hide either error.
  throw new AggregateError([failure, error], `Mac build failed and removing ~/${remote} on ${host} also failed`);
}
if (failure) throw failure;
