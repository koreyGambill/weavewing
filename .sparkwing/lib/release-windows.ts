import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { assets: { type: "string" }, version: { type: "string" }, "wsl-runtime": { type: "string" } } });
if (!values.assets || !values.version || !values["wsl-runtime"] || !process.env.TMPDIR) throw new Error("Expected --assets, --version, --wsl-runtime and TMPDIR");
const run = (command: string, args: string[]) => CP.execFileSync(command, args, { stdio: "inherit" });
process.env.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = "true";
run("vp", ["run", "dist:desktop:artifact", "--platform", "win", "--target", "nsis", "--arch", "x64", "--build-version", values.version, "--skip-build", "--keep-stage", "--wsl-runtime", values["wsl-runtime"], "--output-dir", values.assets, "--verbose"]);
const windowsPath = (path: string) => CP.execFileSync("wslpath", ["-w", path], { encoding: "utf8" }).trim();
const stages = FS.readdirSync(process.env.TMPDIR).filter((name) => name.startsWith("t3code-desktop-win-stage-"));
if (stages.length !== 1) throw new Error("Expected exactly one kept NSIS stage");
const dist = Path.join(process.env.TMPDIR, stages[0]!, "app/dist");
const unpacked = FS.readdirSync(dist).find((name) => name.endsWith("-unpacked"));
if (!unpacked) throw new Error("NSIS stage has no unpacked application");
const verify = Path.join(process.env.TMPDIR, "windows-verify");
FS.mkdirSync(verify);
const esbuild = "scripts/node_modules/.bin/esbuild";
const banner = "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);";
for (const [file, extra] of [["verify-windows-desktop-artifact", ["--define:import.meta.main=false"]], ["smoke-cli-archive", []]] as const)
  run(esbuild, [`scripts/${file}.ts`, "--bundle", "--platform=node", "--format=esm", "--target=node26", `--banner:js=${banner}`, ...extra, `--outfile=${Path.join(verify, `${file}.mjs`)}`]);
run("tar", ["-C", dist, "-cf", Path.join(verify, "payload.tar"), unpacked]);
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const script = `
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('weavewing-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $env:HOME = Join-Path $root 'home'
  $env:USERPROFILE = $env:HOME
  $env:APPDATA = Join-Path $root 'appdata'
  $env:LOCALAPPDATA = Join-Path $root 'localappdata'
  $env:T3CODE_HOME = Join-Path $root 't3-home'
  $env:TEMP = Join-Path $root 'tmp'
  $env:TMP = $env:TEMP
  foreach ($dir in @($env:HOME, $env:APPDATA, $env:LOCALAPPDATA, $env:T3CODE_HOME, $env:TEMP)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  & tar.exe -xf ${psQuote(windowsPath(Path.join(verify, "payload.tar")))} -C $root
  if ($LASTEXITCODE -ne 0) { throw 'Payload extraction failed' }
  $app = Join-Path $root ${psQuote(unpacked)}
  $exe = Join-Path $app 'Weavewing.exe'
  if (!(Test-Path $exe)) { throw 'Packaged executable is missing' }
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $exe ${psQuote(windowsPath(Path.join(verify, "verify-windows-desktop-artifact.mjs")))} --app-dir $app --arch x64 --build-version ${psQuote(values.version)} --verbose
  if ($LASTEXITCODE -ne 0) { throw 'Native payload check failed' }
  & $exe ${psQuote(windowsPath(Path.join(verify, "smoke-cli-archive.mjs")))} --archive ${psQuote(windowsPath(Path.join(values.assets, `t3-${values.version}-win32-x64.zip`)))} --expect-version ${psQuote(values.version)}
  if ($LASTEXITCODE -ne 0) { throw 'Windows CLI smoke failed' }
  Write-Output 'Windows NSIS payload and CLI passed in a throwaway directory. Installer registration was not run.'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}
`;
run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
