import * as CP from "node:child_process";
import { randomBytes } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { assertCleanBundle, assertUpdaterConfig, buildEnvironment } from "./release.ts";

let payload = "";
for await (const chunk of process.stdin) payload += chunk;
const { version, runId, secrets } = JSON.parse(payload) as { version: string; runId: string; secrets: Record<string, string> };
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid release inputs");
const root = Path.join(OS.homedir(), "weavewing-release", runId);
if (process.cwd() !== Path.join(root, "source")) throw new Error("Unexpected Mac source directory");
const nodeVersion = JSON.parse(FS.readFileSync("package.json", "utf8")).engines.node;
const path = `${OS.homedir()}/.vite-plus/js_runtime/node/${nodeVersion}/bin:${OS.homedir()}/.cargo/bin:${OS.homedir()}/.vite-plus/bin:${process.env.PATH}`;
const env = buildEnvironment(path, OS.homedir(), Path.join(root, "tmp"));
env.LANG = "en_US.UTF-8";
const run = (command: string, args: string[]) => CP.execFileSync(command, args, { env, stdio: "inherit" });
const keychain = Path.join(root, "signing.keychain-db");
const signed = Boolean(secrets.APPLE_CSC_LINK);
let mount: string | undefined;
let failure: unknown;
try {
  run("vp", ["env", "install", nodeVersion]);
  const vp = CP.execFileSync("/bin/sh", ["-c", "command -v vp"], { env, encoding: "utf8" }).trim();
  const node = Path.join(Path.dirname(Path.dirname(vp)), "js_runtime/node", nodeVersion, "bin/node");
  const actualVersion = CP.execFileSync(node, ["--version"], { env, encoding: "utf8" }).trim();
  if (actualVersion !== `v${nodeVersion}`) throw new Error(`Expected Node ${nodeVersion}, got ${actualVersion}`);
  env.PATH = `${Path.dirname(node)}:${env.PATH}`;
  run("node", ["--version"]);
  run("vp", ["i", "--frozen-lockfile"]);
  run("rustup", ["target", "add", "aarch64-apple-darwin"]);
  if (signed) {
    const password = randomBytes(24).toString("hex");
    const cert = Path.join(root, "certificate.p12");
    const key = Path.join(root, "AuthKey.p8");
    FS.writeFileSync(cert, Buffer.from(secrets.APPLE_CSC_LINK!, "base64"), { mode: 0o600 });
    FS.writeFileSync(key, secrets.APPLE_API_KEY!, { mode: 0o600 });
    // security accepts passwords only as arguments. Send them through its interactive stdin prompt.
    const security = (commands: string) => CP.execFileSync("security", ["-i"], { input: commands, env, stdio: ["pipe", "ignore", "ignore"] });
    const q = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    security(`create-keychain -p ${q(password)} ${q(keychain)}\nunlock-keychain -p ${q(password)} ${q(keychain)}\nimport ${q(cert)} -k ${q(keychain)} -P ${q(secrets.APPLE_CSC_KEY_PASSWORD!)} -T /usr/bin/codesign\nset-key-partition-list -S apple-tool:,apple:,codesign: -s -k ${q(password)} ${q(keychain)}\n`);
    const identity = CP.execFileSync("security", ["find-identity", "-v", "-p", "codesigning", keychain], { env, encoding: "utf8" }).match(/"([^"]+)"/)?.[1];
    if (!identity) throw new Error("No Developer ID identity in the temporary keychain");
    Object.assign(env, { CSC_KEYCHAIN: keychain, CSC_NAME: identity, CSC_IDENTITY_AUTO_DISCOVERY: "true", T3CODE_CLI_MAC_SIGN_IDENTITY: identity, APPLE_API_KEY: key, APPLE_API_KEY_ID: secrets.APPLE_API_KEY_ID, APPLE_API_ISSUER: secrets.APPLE_API_ISSUER, APPLE_TEAM_ID: secrets.APPLE_TEAM_ID });
  }
  run("node", ["scripts/update-release-package-versions.ts", version]);
  run("vp", ["run", "build:desktop:bundle"]);
  assertCleanBundle(process.cwd());
  run("cargo", ["build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml", "--target", "aarch64-apple-darwin"]);
  FS.mkdirSync("release-monitors/darwin-arm64", { recursive: true });
  FS.copyFileSync("native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor", "release-monitors/darwin-arm64/t3-resource-monitor");
  run("node", ["apps/server/scripts/cli.ts", "build-exe"]);
  run("node", ["scripts/build-cli-archive.ts", "--platform", "mac", "--arch", "arm64", "--version", version, "--resource-monitor-dir", "release-monitors", "--output-dir", Path.join(root, "assets")]);
  run("node", ["scripts/smoke-cli-archive.ts", "--archive", Path.join(root, "assets", `t3-${version}-darwin-arm64.tar.gz`), "--expect-version", version]);
  run("vp", ["run", "dist:desktop:artifact", "--platform", "mac", "--target", "dmg", "--arch", "arm64", "--build-version", version, "--skip-build", "--output-dir", Path.join(root, "assets"), "--verbose", ...(signed ? ["--signed"] : [])]);
  mount = Path.join(root, "mount");
  FS.mkdirSync(mount);
  run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, Path.join(root, "assets", `Weavewing-${version}-arm64.dmg`)]);
  const app = Path.join(mount, "Weavewing.app");
  const updater = assertUpdaterConfig(Path.join(app, "Contents/Resources/app-update.yml"));
  const plist = Path.join(app, "Contents/Info.plist");
  const read = (key: string) => CP.execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], { encoding: "utf8" }).trim();
  const bundleId = read("CFBundleIdentifier");
  const proof = { version: read("CFBundleShortVersionString"), bundleId, updater, signed, nodeVersion, mounted: true, codesign: "not checked" };
  const saveProof = () => FS.writeFileSync(Path.join(root, "mac-proof.json"), JSON.stringify(proof, null, 2));
  saveProof();
  if (proof.version !== version || !["dev.weavewing.desktop", "com.t3tools.t3code"].includes(bundleId)) throw new Error("DMG Info.plist does not match release identity");
  try {
    run("codesign", ["--verify", "--deep", "--strict", app]);
    proof.codesign = "passed";
    const assessment = CP.spawnSync("spctl", ["-a", "-vv", app], { env, encoding: "utf8" });
    const assessmentText = `exit status: ${assessment.status}\n${assessment.stdout ?? ""}${assessment.stderr ?? ""}`;
    FS.writeFileSync(Path.join(root, "mac-gatekeeper.txt"), assessmentText);
    console.log(assessmentText);
  } catch (error) {
    proof.codesign = "failed";
    throw error;
  } finally {
    saveProof();
  }
} catch (error) {
  failure = error;
} finally {
  try {
    if (mount) run("hdiutil", ["detach", mount]);
  } catch (error) {
    failure ??= error;
  }
  try {
    if (signed && FS.existsSync(keychain)) run("security", ["delete-keychain", keychain]);
  } catch (error) {
    failure ??= error;
  }
}
if (failure) throw failure;
