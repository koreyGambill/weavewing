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
  for (const name of FS.readdirSync(dir).filter((name) => name.startsWith("builder-")))
    FS.rmSync(Path.join(dir, name));
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

export function assertCleanBundle(root: string) {
  const dirs = ["apps/server/dist", "apps/web/dist", "apps/desktop/dist-electron"];
  let forkFeed = false;
  for (const dir of dirs) {
    let scanned = 0;
    for (const relative of FS.readdirSync(Path.join(root, dir), { recursive: true })) {
      if (typeof relative !== "string" || !/\.(?:[cm]?js|html|json)$/.test(relative)) continue;
      const path = Path.join(root, dir, relative);
      if (!FS.statSync(path).isFile()) continue;
      const text = FS.readFileSync(path, "utf8");
      // Source maps retain reference documentation and runtime env names, rather than build defaults.
      if (/pk_(?:live|test)_[A-Za-z0-9]+|relay\.t3\.codes|https?:[^\s"'`]*axiom\.co|xaat-[A-Za-z0-9]+/.test(text))
        throw new Error(`Public config or credential baked into ${dir}/${relative}`);
      if (/__T3CODE_BUILD_(?:RELAY|CLERK)[A-Z_]*__/.test(text))
        throw new Error(`Unresolved public build constant in ${dir}/${relative}`);
      if (/(?:analyticsEnabled|posthogEnabled)\s*[:=]\s*(?:true|!0)\b/.test(text))
        throw new Error(`Analytics enabled by default in ${dir}/${relative}`);
      forkFeed ||= text.includes(RELEASE_REPOSITORY);
      scanned++;
    }
    if (!scanned) throw new Error(`Empty bundle directory: ${dir}`);
  }
  if (!forkFeed) throw new Error("The bundle does not contain the Weavewing update repository");
}

export interface NotesSource {
  version: string;
  commit: string;
  upstreamCommit: string;
  upstreamVersion: string;
  previousTag?: string;
  changes: readonly string[];
}

export function renderReleaseNotes(source: NotesSource): string {
  return `# Weavewing ${source.version}

Includes upstream T3 Code through \`${source.upstreamCommit}\` (\`${source.upstreamVersion}\`).
Release commit: \`${source.commit}\`.

${source.previousTag ? `Changes since ${source.previousTag}:` : "First Weavewing release:"}

${source.changes.map((line) => `- ${line}`).join("\n") || "- Initial release."}

## Install

Download the assets for your platform from this release. Verify them against SHA256SUMS.

- Linux x64: make the AppImage executable, or install the deb with \`sudo apt install ./Weavewing-${source.version}-amd64.deb\`.
- Windows x64: run the NSIS installer. For SmartScreen, choose **More info → Run anyway**.
- macOS arm64: open the DMG and move Weavewing to Applications. On macOS 15, use **System Settings → Privacy & Security → Open Anyway**, or run \`xattr -dr com.apple.quarantine /Applications/Weavewing.app\`. Unsigned mac builds don't auto-update. A managed Mac may block the override.
- CLI: unpack the matching \`t3-${source.version}-<platform>-<arch>\` archive and keep its runtime files together.

All desktop builds in this release are unsigned (macOS uses ad-hoc signing).
Weavewing and T3 Code share the default \`~/.t3\` home. Use separate homes if running both.
T3 Connect is unavailable in these builds. Provider subscriptions and direct remote connections work as usual.
For managed machines, see [managed policy](https://github.com/${RELEASE_REPOSITORY}/blob/main/docs/user/managed-policy.md).
`;
}

export function releaseNotes(root: string, version: string, commit: string): string {
  const previousTag = git(root, "tag", "--merged", commit, "--sort=-version:refname", "--list", `${TAG_PREFIX}*`)
    .split("\n").find((tag) => tag && tag !== `${TAG_PREFIX}${version}`);
  const upstreamCommit = git(root, "merge-base", commit, "refs/remotes/upstream/main");
  const upstreamVersion = git(root, "describe", "--tags", "--match", "v*", "--abbrev=0", upstreamCommit);
  const range = previousTag ? `${previousTag}..${commit}` : `${upstreamCommit}..${commit}`;
  const changes = git(root, "log", "--first-parent", "--format=%s", range).split("\n").filter(Boolean);
  return renderReleaseNotes({ version, commit, upstreamCommit, upstreamVersion, previousTag, changes });
}
