import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import { createServer } from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { windowsInterop } from "./windows-interop.ts";

const timeout = "<3>WSL (2387299 - ) ERROR: UtilAcceptVsock:281: accept4 failed 110";

for (const { mode, status, attempts } of [
  { mode: "recovers", status: 0, attempts: 2 },
  { mode: "smoke-fails", status: 1, attempts: 1 },
  { mode: "different-error", status: 1, attempts: 1 },
  { mode: "exhausts", status: 1, attempts: 3 },
]) {
  test(`Windows smoke launch: ${mode}`, (t) => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "release-windows-"));
    t.after(() => FS.rmSync(root, { recursive: true }));
    const bin = Path.join(root, "bin");
    const resources = Path.join(root, "t3code-desktop-win-stage-fixture/app/dist/win-unpacked/resources");
    FS.mkdirSync(bin);
    FS.mkdirSync(Path.join(root, "scripts/node_modules/.bin"), { recursive: true });
    FS.mkdirSync(resources, { recursive: true });
    FS.writeFileSync(Path.join(resources, "app-update.yml"), "provider: github\nowner: koreyGambill\nrepo: weavewing\n");
    for (const name of ["bin/vp", "bin/tar", "scripts/node_modules/.bin/esbuild"])
      FS.writeFileSync(Path.join(root, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    FS.writeFileSync(Path.join(bin, "wslpath"), '#!/bin/sh\nprintf "%s\\n" "$2"\n', { mode: 0o755 });
    FS.writeFileSync(Path.join(bin, "powershell.exe"), `#!${process.execPath}
const fs = require("node:fs");
const first = !fs.existsSync("attempts");
fs.appendFileSync("attempts", "launch\\n");
const encoded = process.argv.at(-1);
fs.writeFileSync("encoded", encoded);
const script = Buffer.from(encoded, "base64").toString("utf16le");
if (${JSON.stringify(mode)} === "smoke-fails") {
  const marker = script.match(/\\[Console\\]::Error.WriteLine\\('([^']+)'\\)/);
  if (marker) console.error(marker[1]);
}
if (${JSON.stringify(mode)} === "recovers" && !first) {
  console.log("fixture smoke passed");
  process.exit(0);
}
console.error(${JSON.stringify(mode === "different-error" ? timeout + ": extra diagnostic" : timeout)});
process.exit(1);
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("./release-windows.ts", import.meta.url)),
      "--assets", root, "--version", "0.1.0", "--wsl-runtime", Path.join(root, "linux.tar.gz"),
    ], {
      cwd: root,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: root },
      encoding: "utf8",
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(FS.readFileSync(Path.join(root, "attempts"), "utf8").trim().split("\n").length, attempts);
    assert.equal(result.stderr.match(/retrying Windows smoke/gi)?.length ?? 0, attempts - 1);
    assert.ok(result.stderr.includes(timeout));
    assert.ok(!result.stderr.includes(FS.readFileSync(Path.join(root, "encoded"), "utf8")));
    if (status === 0) assert.match(result.stdout, /fixture smoke passed/);
    if (mode === "smoke-fails") assert.match(result.stderr, /Weavewing Windows smoke started/);
  });
}

test("WSL interop prefers the inherited listener and falls back from missing or stale sockets", async (t) => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "w-"));
  t.after(() => FS.rmSync(root, { recursive: true }));
  const owner = FS.statSync(root).uid;
  const socketPath = (pid: number) => Path.join(root, `${pid}_interop`);
  const stale = socketPath(1);
  const regular = socketPath(2);
  const fallback = socketPath(3);
  const inherited = socketPath(4);
  const alias = socketPath(5);
  const dangling = socketPath(6);
  const stopped = spawnSync(process.execPath, ["-e",
    'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))', stale]);
  assert.equal(stopped.status, 0, stopped.stderr.toString());
  assert.ok(FS.lstatSync(stale).isSocket());
  FS.writeFileSync(regular, "");
  FS.symlinkSync(inherited, alias);
  FS.symlinkSync(socketPath(7), dangling);
  const listen = async (path: string) => {
    const server = createServer();
    t.after(() => { server.close(); });
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  };
  assert.equal(windowsInterop(undefined, root, owner), undefined);
  await listen(fallback);
  for (const socket of [undefined, stale, regular, dangling])
    assert.equal(windowsInterop(socket, root, owner), fallback);
  await listen(inherited);
  assert.equal(windowsInterop(inherited, root, owner), inherited);
  assert.equal(windowsInterop(alias, root, owner), alias);
});
