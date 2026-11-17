import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { parseArgs } from "node:util";

import { macStartup, normalizeArtifacts } from "./release.ts";

const { values } = parseArgs({ options: Object.fromEntries(["worktree", "commit", "version", "run", "evidence"].map((name) => [name, { type: "string" as const }])) });
const { worktree, commit, version, run: runId, evidence } = values;
if (!worktree || !commit || !version || !runId || !evidence || !/^[a-zA-Z0-9_-]+$/.test(runId) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid Mac build inputs");
const remote = `weavewing-release/${runId}`;
const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "moonborn"];
const run = (command: string, args: string[], input?: string) => CP.execFileSync(command, args, { input, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"], maxBuffer: 1024 * 1024 });
const signingNames = ["APPLE_CSC_LINK", "APPLE_CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"];
const present = signingNames.filter((name) => process.env[name]);
if (present.length && present.length !== signingNames.length) throw new Error("Apple signing is partially configured. Supply all six secrets or none.");
let failure: unknown;
try {
  run("ssh", [...ssh, macStartup(runId)]);
  const archive = CP.spawn("git", ["-C", worktree, "archive", commit], { stdio: ["ignore", "pipe", "inherit"] });
  const extract = CP.spawn("ssh", [...ssh, `tar -x -C ~/${remote}/source`], { stdio: ["pipe", "inherit", "inherit"] });
  archive.stdout.pipe(extract.stdin);
  const exited = (child: CP.ChildProcess) => new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Source transfer exited ${code}`)));
  });
  await Promise.all([exited(archive), exited(extract)]);
  // The remote helper reads the JSON payload on stdin; secrets never become ssh arguments.
  const nodeVersion = JSON.parse(FS.readFileSync(Path.join(worktree, "package.json"), "utf8")).engines.node;
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error("Invalid managed Node version");
  run("ssh", [...ssh, `env -C ~/${remote}/source ~/.vite-plus/js_runtime/node/${nodeVersion}/bin/node .sparkwing/lib/release-mac-build.ts`], JSON.stringify({ version, runId, secrets: Object.fromEntries(signingNames.map((name) => [name, process.env[name] ?? ""])) }));
} catch (error) {
  failure = error;
}
try {
  FS.mkdirSync(Path.join(evidence, "assets"), { recursive: true });
  run("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `moonborn:${remote}/assets/*`, Path.join(evidence, "assets/")]);
  normalizeArtifacts(Path.join(evidence, "assets"), "mac", version);
  for (const file of ["mac-proof.json", "mac-gatekeeper.txt"])
    if (CP.spawnSync("ssh", [...ssh, `test -f ~/${remote}/${file}`], { stdio: "ignore" }).status === 0)
      run("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `moonborn:${remote}/${file}`, Path.join(evidence, file)]);
} catch (error) {
  failure ??= error;
} finally {
  try {
    run("ssh", [...ssh, `rm -rf ~/${remote}`]);
  } catch (error) {
    failure ??= error;
  }
}
if (failure) throw failure;
