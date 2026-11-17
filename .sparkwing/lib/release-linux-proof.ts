import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";
import { parseArgs } from "node:util";

import { assertUpdaterConfig } from "./release.ts";

const { values } = parseArgs({ options: { assets: { type: "string" }, version: { type: "string" }, evidence: { type: "string" } } });
if (!values.assets || !values.version || !values.evidence || !process.env.TMPDIR) throw new Error("Expected --assets, --version, --evidence and TMPDIR");
const root = FS.mkdtempSync(Path.join(process.env.TMPDIR, "appimage-proof-"));
const home = Path.join(root, "home");
FS.mkdirSync(home);
const env = { ...process.env, HOME: home, T3CODE_HOME: Path.join(home, "t3"), XDG_CONFIG_HOME: Path.join(home, "config"), ELECTRON_RUN_AS_NODE: "1" };
const image = Path.join(values.assets, `Weavewing-${values.version}-x86_64.AppImage`);
FS.chmodSync(image, 0o755);
CP.execFileSync(image, ["--appimage-extract"], { cwd: root, env, stdio: "ignore" });
const app = Path.join(root, "squashfs-root");
const updater = assertUpdaterConfig(Path.join(app, "resources/app-update.yml"));
const bin = Path.join(app, "resources/app.asar/apps/server/dist/bin.mjs");
const output = CP.execFileSync(Path.join(app, "AppRun"), [bin, "--version"], { cwd: root, env, encoding: "utf8" }).trim();
if (!output.includes(values.version)) throw new Error(`AppImage version mismatch: ${output}`);
const port = await new Promise<number>((resolve, reject) => {
  const socket = Net.createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address();
    if (!address || typeof address === "string") return reject(new Error("Missing smoke port"));
    socket.close(() => resolve(address.port));
  });
});
const child = CP.spawn(Path.join(app, "AppRun"), [bin, "serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"], { cwd: root, env, stdio: "ignore" });
const closed = new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", () => resolve());
});
let status = 0;
try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    if (response) {
      status = response.status;
      const body = await response.text();
      if (status === 200 && body.includes("<html")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (status !== 200) throw new Error(`AppImage bundled server failed to serve HTML: HTTP ${status}, exit ${child.exitCode}`);
} finally {
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try { await closed; } finally { clearTimeout(force); }
}
FS.writeFileSync(Path.join(values.evidence, "linux-proof.json"), JSON.stringify({ extracted: true, version: output, updater, httpStatus: status, home: "scratch", result: "passed" }, null, 2));
console.log(`AppImage updater, bundled CLI ${output} and real HTTP request passed (HTTP ${status}).`);
