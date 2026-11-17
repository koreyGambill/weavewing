import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: Object.fromEntries(["worktree", "commit", "version", "run", "evidence"].map((name) => [name, { type: "string" as const }])) });
const { worktree, commit, version, run: runId, evidence } = values;
if (!worktree || !commit || !version || !runId || !evidence || !/^[a-zA-Z0-9_-]+$/.test(runId) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid Mac build inputs");
const remote = `weavewing-release/${runId}`;
const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "moonborn"];
const run = (command: string, args: string[], input?: string) => CP.execFileSync(command, args, { input, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"], maxBuffer: 1024 * 1024 });
const signingNames = ["APPLE_CSC_LINK", "APPLE_CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"];
const present = signingNames.filter((name) => process.env[name]);
if (present.length && present.length !== signingNames.length) throw new Error("Apple signing is partially configured. Supply all six secrets or none.");
try {
  run("ssh", [...ssh, `umask 077; mkdir -p ~/${remote}/source ~/${remote}/assets ~/${remote}/tmp`]);
  const archive = CP.spawn("git", ["-C", worktree, "archive", commit], { stdio: ["ignore", "pipe", "inherit"] });
  const extract = CP.spawn("ssh", [...ssh, `tar -x -C ~/${remote}/source`], { stdio: ["pipe", "inherit", "inherit"] });
  archive.stdout.pipe(extract.stdin);
  const exited = (child: CP.ChildProcess) => new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Source transfer exited ${code}`)));
  });
  await Promise.all([exited(archive), exited(extract)]);
  // The remote helper reads the JSON payload on stdin; secrets never become ssh arguments.
  run("ssh", [...ssh, `env -C ~/${remote}/source node .sparkwing/lib/release-mac-build.ts`], JSON.stringify({ version, runId, secrets: Object.fromEntries(signingNames.map((name) => [name, process.env[name] ?? ""])) }));
  FS.mkdirSync(Path.join(evidence, "assets"), { recursive: true });
  run("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `moonborn:${remote}/assets/*`, Path.join(evidence, "assets/")]);
  run("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `moonborn:${remote}/mac-proof.json`, Path.join(evidence, "mac-proof.json")]);
} finally {
  run("ssh", [...ssh, `rm -rf ~/${remote}`]);
}
