import * as CP from "node:child_process";
import { randomBytes } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { acquireLock, assertNoNodeTracing, developerIdProof, type CheckResult, securityCommand, withSigningKeychain } from "./release-mac-signing.ts";
import { assertCleanBundle, assertUpdaterConfig, buildEnvironment, MACOS_BUNDLE_ID, macAssetDigests, macSignedAssets, releaseInputs } from "./release.ts";

assertNoNodeTracing(process.env);
const runId = process.argv[2] ?? "";
if (!/^run-[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid Mac run id");
const workspace = Path.join(OS.homedir(), "weavewing-release");
const root = Path.join(workspace, runId);
const source = Path.join(root, "source");
if (process.cwd() !== source) throw new Error("Unexpected Mac source directory");

// This process can outlive the controller's SSH connection.
process.on("exit", () => {
  try {
    process.chdir(root);
    for (const dir of [source, Path.join(root, "tmp")])
      if (FS.existsSync(dir)) FS.rmSync(dir, { recursive: true });
  } catch (error) {
    console.error("Mac build source cleanup failed:", error);
    process.exitCode = 1;
  }
});
// A lost SSH connection must not crash this process before cleanup; children see the closed pipe and exit.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
let active: CP.ChildProcess | undefined;
let stopped: string | undefined;
// Commands run asynchronously so these handlers fire mid-build; the rejection unwinds through every cleanup.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    stopped ??= signal;
    try {
      if (active?.pid) process.kill(-active.pid, "SIGTERM");
    } catch {
      // The group already exited; its close event settles the command.
    }
  });
let payload = "";
for await (const chunk of process.stdin) payload += chunk;
const { version, channel, secrets } = JSON.parse(payload) as { version: string; channel: string; secrets: Record<string, string> };
const release = releaseInputs(version, "mac", channel);
const nodeVersion = JSON.parse(FS.readFileSync("package.json", "utf8")).engines.node;
const path = `${OS.homedir()}/.vite-plus/js_runtime/node/${nodeVersion}/bin:${OS.homedir()}/.cargo/bin:${OS.homedir()}/.vite-plus/bin:${process.env.PATH}`;
const env = buildEnvironment(path, OS.homedir(), Path.join(root, "tmp"), release.channel);
env.LANG = "en_US.UTF-8";
const keychain = Path.join(root, "signing.keychain-db");
const certificate = Path.join(root, "certificate.p12");
const apiKey = Path.join(root, "AuthKey.p8");
const signed = Boolean(secrets.APPLE_CSC_LINK);
const teamId = secrets.APPLE_TEAM_ID ?? "";
if (signed && !/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("APPLE_TEAM_ID must be the 10-character Apple Developer Team ID");
const assets = Path.join(root, "assets");
const cliArchive = Path.join(assets, `t3-${version}-darwin-arm64.tar.gz`);

// Registered before either credential file exists; it also runs when an uncaught error ends the process.
process.on("exit", () => {
  for (const file of [certificate, apiKey]) FS.rmSync(file, { force: true });
});
const run = (command: string, args: string[]) => new Promise<void>((resolve, reject) => {
  if (stopped) return reject(new Error(`Mac build stopped by ${stopped}`));
  // Its own process group lets a stop reach grandchildren that vp does not forward signals to.
  const child = CP.spawn(command, args, { env, stdio: "inherit", detached: true });
  active = child;
  child.once("error", reject);
  child.once("close", (code, signal) => {
    active = undefined;
    if (code === 0) resolve();
    else reject(new Error(`${command} ${args[0] ?? ""} ${stopped ? `stopped by ${stopped}` : `exited ${code ?? signal}`}`));
  });
});

let mount: string | undefined;
let failure: unknown;
try {
  await run("vp", ["env", "install", nodeVersion]);
  const vp = CP.execFileSync("/bin/sh", ["-c", "command -v vp"], { env, encoding: "utf8" }).trim();
  const node = Path.join(Path.dirname(Path.dirname(vp)), "js_runtime/node", nodeVersion, "bin/node");
  const actualVersion = CP.execFileSync(node, ["--version"], { env, encoding: "utf8" }).trim();
  if (actualVersion !== `v${nodeVersion}`) throw new Error(`Expected Node ${nodeVersion}, got ${actualVersion}`);
  env.PATH = `${Path.dirname(node)}:${env.PATH}`;
  await run("node", ["--version"]);
  await run("vp", ["i", "--frozen-lockfile"]);
  await run("rustup", ["target", "add", "aarch64-apple-darwin"]);
  await run("node", ["scripts/update-release-package-versions.ts", version]);
  await run("vp", ["run", "build:desktop:bundle"]);
  assertCleanBundle(process.cwd());
  await run("cargo", ["build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml", "--target", "aarch64-apple-darwin"]);
  FS.mkdirSync("release-monitors/darwin-arm64", { recursive: true });
  FS.copyFileSync("native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor", "release-monitors/darwin-arm64/t3-resource-monitor");
  await run("node", ["apps/server/scripts/cli.ts", "build-exe"]);
  const packageArtifacts = async () => {
    await run("node", ["scripts/build-cli-archive.ts", "--platform", "mac", "--arch", "arm64", "--version", version, "--resource-monitor-dir", "release-monitors", "--output-dir", assets]);
    await run("node", ["scripts/smoke-cli-archive.ts", "--archive", cliArchive, "--expect-version", version]);
    await run("vp", ["run", "dist:desktop:artifact", "--platform", "mac", "--target", "dmg", "--arch", "arm64", "--build-version", version, "--skip-build", "--output-dir", assets, "--verbose", ...(signed ? ["--signed"] : [])]);
  };
  if (signed) {
    // The search list is per user, so two signing builds on this Mac must not interleave.
    const unlock = acquireLock(Path.join(workspace, "signing.lock"));
    try {
      FS.writeFileSync(certificate, Buffer.from(secrets.APPLE_CSC_LINK!, "base64"), { mode: 0o600 });
      FS.writeFileSync(apiKey, secrets.APPLE_API_KEY!, { mode: 0o600 });
      await withSigningKeychain(securityCommand(env), { keychain, password: randomBytes(24).toString("hex"), certificate, certificatePassword: secrets.APPLE_CSC_KEY_PASSWORD!, teamId }, async (identity) => {
        // electron-builder matches CSC_NAME against `security find-identity` lines, which include the hash.
        Object.assign(env, { CSC_KEYCHAIN: keychain, CSC_NAME: identity.hash, CSC_IDENTITY_AUTO_DISCOVERY: "true", T3CODE_CLI_MAC_SIGN_IDENTITY: identity.hash, APPLE_API_KEY: apiKey, APPLE_API_KEY_ID: secrets.APPLE_API_KEY_ID, APPLE_API_ISSUER: secrets.APPLE_API_ISSUER, APPLE_TEAM_ID: teamId });
        await packageArtifacts();
      });
    } finally {
      for (const file of [certificate, apiKey]) FS.rmSync(file, { force: true });
      unlock();
    }
  } else {
    await packageArtifacts();
  }
  mount = Path.join(root, "mount");
  FS.mkdirSync(mount);
  await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, Path.join(assets, `Weavewing-${version}-arm64.dmg`)]);
  const app = Path.join(mount, release.channel === "test" ? "Weavewing (Nightly).app" : "Weavewing.app");
  const updater = assertUpdaterConfig(Path.join(app, "Contents/Resources/app-update.yml"));
  const plist = Path.join(app, "Contents/Info.plist");
  const read = (key: string) => CP.execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim();
  const bundleId = read("CFBundleIdentifier");
  const proof: Record<string, unknown> = { version: read("CFBundleShortVersionString"), bundleId, updater, signed, nodeVersion, mounted: true, codesign: "not checked" };
  const saveProof = () => FS.writeFileSync(Path.join(root, "mac-proof.json"), JSON.stringify(proof, null, 2));
  saveProof();
  if (proof.version !== version || bundleId !== MACOS_BUNDLE_ID) throw new Error("DMG Info.plist does not match release identity");
  const check = (command: string, args: string[]): CheckResult => {
    const result = CP.spawnSync(command, args, { env, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };
  try {
    await run("codesign", ["--verify", "--deep", "--strict", app]);
    proof.codesign = "passed";
    const assessment = check("spctl", ["-a", "-vv", "-t", "exec", app]);
    const assessmentText = `exit status: ${assessment.status}\n${assessment.output}`;
    FS.writeFileSync(Path.join(root, "mac-gatekeeper.txt"), assessmentText);
    console.log(assessmentText);
    if (signed) {
      const cliDir = Path.join(root, "cli-proof");
      FS.mkdirSync(cliDir);
      await run("tar", ["-xzf", cliArchive, "-C", cliDir]);
      const cli = Path.join(cliDir, `t3-${version}-darwin-arm64`, "t3");
      await run("codesign", ["--verify", "--strict", cli]);
      const developerId = developerIdProof(teamId, { gatekeeper: assessment, stapler: check("xcrun", ["stapler", "validate", app]), app: check("codesign", ["-dv", "--verbose=4", app]), cli: check("codesign", ["-dv", "--verbose=4", cli]) });
      proof.developerId = developerId;
      if (developerId.failures.length) throw new Error(`The macOS build is not a notarized Developer ID build: ${developerId.failures.join("; ")}`);
    }
    // Binds this proof to the exact bytes the controller copies and later publishes.
    proof.assets = macAssetDigests(assets, macSignedAssets(version));
  } catch (error) {
    proof.codesign = "failed";
    throw error;
  } finally {
    saveProof();
  }
  if (stopped) throw new Error(`Mac build stopped by ${stopped}`);
} catch (error) {
  failure = error;
}
const cleanupErrors: unknown[] = [];
for (const step of [
  () => mount && CP.execFileSync("hdiutil", ["detach", mount], { env, stdio: "inherit" }),
  () => FS.rmSync(certificate, { force: true }),
  () => FS.rmSync(apiKey, { force: true }),
]) {
  try {
    step();
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], "Mac build failed and cleanup also failed");
if (failure) throw failure;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Mac build cleanup failed");
