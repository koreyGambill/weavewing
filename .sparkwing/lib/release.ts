import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { git } from "./checkout.ts";

const identityUrl = new URL("../../packages/shared/src/releaseIdentity.ts", import.meta.url);
// Archived pipeline revisions must also bootstrap before the shared identity module is available.
const identity: { RELEASE_REPOSITORY: string; RELEASE_TAG_PREFIX: string } = FS.existsSync(identityUrl)
  ? await import(identityUrl.href)
  : { RELEASE_REPOSITORY: "koreyGambill/weavewing", RELEASE_TAG_PREFIX: "weavewing-v" };
export const RELEASE_REPOSITORY = identity.RELEASE_REPOSITORY;
export const TAG_PREFIX = identity.RELEASE_TAG_PREFIX;
export const PLATFORMS = ["linux", "win", "mac"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function assertTagAbsent(tag: string, refs: readonly { ref: string }[]) {
  if (refs.some((entry) => entry.ref === `refs/tags/${tag}`))
    throw new Error(`Git tag ${tag} already exists; remove the stale tag before drafting or promoting`);
}

export function assertPushedCommit(root: string, commit: string) {
  git(root, "fetch", "origin", "main");
  git(root, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main");
}

export function macPreflight(nodeVersion: string) {
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error("Invalid Node version");
  return `set -eu
export PATH="$HOME/.cargo/bin:$HOME/.vite-plus/bin:$PATH"
need() { command -v "$1" >/dev/null || { echo "Missing $1. Install: $2" >&2; exit 1; }; }
need vp 'curl -fsSL https://vite.plus | bash'
need rustup 'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
need cargo 'rustup toolchain install 1.100.0 --profile minimal --component rustfmt'
need tar 'xcode-select --install'
need xcrun 'xcode-select --install'
xcrun --find notarytool || { echo 'Install: xcode-select --install' >&2; exit 1; }
node="$HOME/.vite-plus/js_runtime/node/${nodeVersion}/bin/node"
test -x "$node" || { echo "Missing $node. Install: vp env install ${nodeVersion}" >&2; exit 1; }
test "$("$node" --version)" = 'v${nodeVersion}' || { echo 'Install: vp env install ${nodeVersion}' >&2; exit 1; }
echo "Managed Node: $node"
test "$(uname -m)" = arm64 || { echo 'An arm64 Mac is required' >&2; exit 1; }
available=$(df -k "$HOME" | tail -1 | awk '{print $4}')
test "$available" -gt 31457280 || { echo 'Free at least 30 GiB on moonborn before building' >&2; exit 1; }`;
}

export function macStartup(runId: string) {
  if (!/^run-[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid Mac run id");
  return `set -eu
umask 077
mkdir -p "$HOME/weavewing-release"
for old in "$HOME"/weavewing-release/run-*; do
  test -d "$old" || continue
  test "$old" != "$HOME/weavewing-release/${runId}" || continue
  if test -f "$old/signing.keychain-db"; then security delete-keychain "$old/signing.keychain-db"; fi
  rm -rf "$old"
done
mkdir -p "$HOME/weavewing-release/${runId}/source" "$HOME/weavewing-release/${runId}/assets" "$HOME/weavewing-release/${runId}/tmp"`;
}

export function releaseInputs(version: string, platforms: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("--version must be plain semver (for example 1.0.0)");
  const selected = platforms.split(",");
  if (!selected.length || selected.some((p) => !PLATFORMS.includes(p as Platform)) || new Set(selected).size !== selected.length)
    throw new Error("--platforms must be a comma-separated subset of linux,win,mac");
  return { version, platforms: selected as Platform[], tag: `${TAG_PREFIX}${version}` };
}

export function expectedAssets(version: string, platforms: readonly Platform[]): string[] {
  return platforms.flatMap((platform) => {
    switch (platform) {
      case "linux": return [`Weavewing-${version}-x86_64.AppImage`, `Weavewing-${version}-amd64.deb`, "latest-linux.yml", `t3-${version}-linux-x64.tar.gz`];
      case "win": return [`Weavewing-${version}-x64.exe`, `Weavewing-${version}-x64.exe.blockmap`, "latest.yml", `t3-${version}-win32-x64.zip`];
      case "mac": return [`Weavewing-${version}-arm64.dmg`, `Weavewing-${version}-arm64.dmg.blockmap`, `Weavewing-${version}-arm64.zip`, `Weavewing-${version}-arm64.zip.blockmap`, "latest-mac.yml", `t3-${version}-darwin-arm64.tar.gz`];
    }
  }).sort();
}

export function normalizeArtifacts(dir: string, platform: Platform, version: string) {
  if (platform === "linux") {
    const name = FS.readdirSync(dir).find((name) => name.endsWith(".AppImage"));
    const expected = `Weavewing-${version}-x86_64.AppImage`;
    if (name && name !== expected) {
      FS.renameSync(Path.join(dir, name), Path.join(dir, expected));
      const manifest = Path.join(dir, "latest-linux.yml");
      FS.writeFileSync(manifest, FS.readFileSync(manifest, "utf8").replaceAll(name, expected));
    }
  }
  if (platform === "win" && FS.existsSync(Path.join(dir, "latest-win-x64.yml")))
    FS.renameSync(Path.join(dir, "latest-win-x64.yml"), Path.join(dir, "latest.yml"));
  for (const name of FS.readdirSync(dir).filter((name) => name.startsWith("builder-"))) {
    const metadata = Path.join(Path.dirname(dir), "build-metadata", platform);
    FS.mkdirSync(metadata, { recursive: true });
    FS.renameSync(Path.join(dir, name), Path.join(metadata, name));
  }
}

export function assetInventory(dir: string, names: readonly string[]) {
  return names.map((name) => {
    const file = Path.join(dir, name);
    const stat = FS.lstatSync(file);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty release asset: ${name}`);
    return { name, size: stat.size, sha256: Crypto.createHash("sha256").update(FS.readFileSync(file)).digest("hex") };
  });
}

export function verifyChecksums(dir: string, names: readonly string[], checksums: string) {
  const parsed = new Map<string, string>();
  for (const line of checksums.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
    if (!match || parsed.has(match[2]!)) throw new Error("Malformed or duplicate SHA256SUMS entry");
    parsed.set(match[2]!, match[1]!);
  }
  if (parsed.size !== names.length || names.some((name) => !parsed.has(name)))
    throw new Error("SHA256SUMS does not cover the exact expected asset set");
  for (const asset of assetInventory(dir, names))
    if (parsed.get(asset.name) !== asset.sha256) throw new Error(`Checksum mismatch: ${asset.name}`);
}

export function verifyPromotionAssets(download: string, names: readonly string[], evidence: string, tag: string, commit: string) {
  const release = JSON.parse(FS.readFileSync(Path.join(evidence, "release.json"), "utf8"));
  if (release.repository !== RELEASE_REPOSITORY || release.tag !== tag || release.target !== commit || release.ci !== "passed" || release.draft !== true)
    throw new Error("Draft evidence does not match the release commit or a CI-verified draft");
  const local = Path.join(evidence, "assets");
  const checksums = FS.readFileSync(Path.join(local, "SHA256SUMS"), "utf8");
  verifyChecksums(local, names, checksums);
  verifyChecksums(download, names, checksums);
  if (FS.readFileSync(Path.join(download, "SHA256SUMS"), "utf8") !== checksums)
    throw new Error("Uploaded SHA256SUMS differs from local draft evidence");
}

export function assertUpdaterConfig(file: string) {
  const text = FS.readFileSync(file, "utf8");
  const [owner, repo] = RELEASE_REPOSITORY.split("/");
  for (const [key, expected] of Object.entries({ provider: "github", owner, repo })) {
    const values = [...text.matchAll(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "gm"))];
    if (values.length !== 1 || values[0]![1]!.replace(/^['"]|['"]$/g, "") !== expected)
      throw new Error(`Packaged updater must use github ${RELEASE_REPOSITORY}: ${file}`);
  }
  return { provider: "github", owner, repo };
}

/** Only build inputs cross the release boundary; provider and telemetry credentials stay outside. */
export function buildEnvironment(path: string, home: string, tmp: string): Record<string, string> {
  return {
    PATH: path, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", CI: "true",
    T3CODE_DESKTOP_UPDATE_REPOSITORY: RELEASE_REPOSITORY,
    T3CODE_DESKTOP_CHANNEL: "latest", CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CARGO_BUILD_JOBS: "6", RAYON_NUM_THREADS: "6", UV_THREADPOOL_SIZE: "6", MAKEFLAGS: "-j6", XZ_DEFAULTS: "-T6",
    ...(process.env.WSL_INTEROP ? { WSL_INTEROP: process.env.WSL_INTEROP } : {}),
  };
}

function initializer(text: string, start: number) {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (/["'`]/.test(char)) quote = char;
    else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) {
      if (depth === 0) return text.slice(start, i);
      depth--;
    } else if (depth === 0 && /[,;\n]/.test(char)) return text.slice(start, i);
  }
  return text.slice(start);
}

export function assertCleanBundle(root: string) {
  const dirs = ["apps/server/dist", "apps/web/dist", "apps/desktop/dist-electron"];
  for (const dir of dirs) {
    let scanned = 0;
    for (const relative of FS.readdirSync(Path.join(root, dir), { recursive: true })) {
      if (typeof relative !== "string" || !/\.(?:[cm]?js|html|json)$/.test(relative)) continue;
      const path = Path.join(root, dir, relative);
      if (!FS.statSync(path).isFile()) continue;
      const text = FS.readFileSync(path, "utf8");
      // Source maps retain reference documentation and runtime env names, rather than build defaults.
      if (/pk_(?:live|test)_[A-Za-z0-9]+|phc_[A-Za-z0-9_]+|(?:[\w-]+\.)*posthog\.[a-z]+|ingest\.t3\.codes|relay\.t3\.codes|https?:[^\s"'`]*axiom\.co|xaat-[A-Za-z0-9]+/i.test(text))
        throw new Error(`Public config or credential baked into ${dir}/${relative}`);
      if (/__T3CODE_BUILD_(?:RELAY|CLERK)[A-Z_]*__/.test(text))
        throw new Error(`Unresolved public build constant in ${dir}/${relative}`);
      if (/https?:[^\s"'`]*(?:\/v1\/(?:traces|metrics|logs)|:\b431[78]\b|otlp)[^\s"'`]*/i.test(text))
        throw new Error(`OTLP endpoint baked into ${dir}/${relative}`);
      for (const match of text.matchAll(/\b(?:tracesUrl|tracesDataset|tracesToken)["'`]?\s*[:=]\s*/g))
        if (/(["'`])[^"'`]+\1/.test(initializer(text, match.index + match[0].length)))
          throw new Error(`Non-empty tracing default in ${dir}/${relative}`);
      if (/["'`]T3CODE_TELEMETRY_ENABLED["'`]\s*\)\s*\.pipe\(\s*[\w$.]+\(\s*(?:true|!0)\s*\)/.test(text))
        throw new Error(`Telemetry enabled by default in ${dir}/${relative}`);
      if (/(?:analyticsEnabled|posthogEnabled)\s*[:=]\s*(?:true|!0)\b/.test(text))
        throw new Error(`Analytics enabled by default in ${dir}/${relative}`);
      scanned++;
    }
    if (!scanned) throw new Error(`Empty bundle directory: ${dir}`);
  }
}

export interface NotesSource {
  version: string;
  commit: string;
  upstreamCommit: string;
  upstreamVersion: string;
  previousTag?: string;
  compareFrom?: string;
  changes: readonly string[];
}

export function renderReleaseNotes(source: NotesSource): string {
  return `# Weavewing ${source.version}

Includes upstream T3 Code through \`${source.upstreamCommit}\` (\`${source.upstreamVersion}\`).
Release commit: \`${source.commit}\`.

${source.previousTag ? `Changes since ${source.previousTag}:` : "First Weavewing release:"}

${source.changes.map((line) => `- ${line}`).join("\n") || "- Initial release."}

[Full comparison](https://github.com/${RELEASE_REPOSITORY}/compare/${source.previousTag ?? source.compareFrom ?? source.upstreamCommit}...${source.commit}).

## Install

Download the assets for your platform from this release. Verify them against SHA256SUMS.

- Linux x64: make the AppImage executable, or install the deb with \`sudo apt install ./Weavewing-${source.version}-amd64.deb\`.
- Windows x64: run the NSIS installer. For SmartScreen, choose **More info → Run anyway**.
- macOS arm64: open the DMG and move Weavewing to Applications. On macOS 15, try opening the app once. After it is blocked, use **System Settings → Privacy & Security → Open Anyway**, or run \`xattr -dr com.apple.quarantine /Applications/Weavewing.app\`. Unsigned mac builds don't auto-update. A managed Mac may block the override.
- CLI: unpack the matching \`t3-${source.version}-<platform>-<arch>\` archive and keep its runtime files together.

All desktop builds in this release are unsigned (macOS uses ad-hoc signing).
Weavewing and T3 Code share the default \`~/.t3\` home. Use separate homes if running both.
T3 Connect is unavailable in these builds. Provider subscriptions and direct remote connections work as usual.
For managed machines, see [managed policy](https://github.com/${RELEASE_REPOSITORY}/blob/main/docs/user/managed-policy.md).
`;
}

export function releaseNotes(root: string, version: string, commit: string, options: { draftBody?: string | null; notesFile?: string } = {}): string {
  if (options.notesFile) return FS.readFileSync(options.notesFile, "utf8");
  if (options.draftBody != null) return options.draftBody;
  const previousTag = git(root, "tag", "--merged", commit, "--sort=-version:refname", "--list", `${TAG_PREFIX}*`)
    .split("\n").find((tag) => tag && tag !== `${TAG_PREFIX}${version}`);
  const upstreamCommit = git(root, "merge-base", commit, "refs/remotes/upstream/main");
  const upstreamVersion = git(root, "describe", "--tags", "--match", "v[0-9]*", "--exclude", "*-*", "--abbrev=0", upstreamCommit);
  const firstForkCommit = previousTag ? undefined : git(root, "rev-list", "--first-parent", "--reverse", commit, "--not", "refs/remotes/upstream/main").split("\n")[0];
  const forkPoint = firstForkCommit ? git(root, "rev-parse", `${firstForkCommit}^1`) : upstreamCommit;
  const range = `${previousTag ?? forkPoint}..${commit}`;
  const changes = git(root, "log", "--first-parent", ...(!previousTag ? ["--merges", "--max-count=40"] : []), "--format=%s", range).split("\n").filter(Boolean);
  return renderReleaseNotes({ version, commit, upstreamCommit, upstreamVersion, previousTag, compareFrom: forkPoint, changes });
}
