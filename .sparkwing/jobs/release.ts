import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { ConcurrencyGroup, type Context, definePipeline, memoKey } from "@sparkwing/sdk";

import { checkout, checkoutArgs, git, logged, type Checkout } from "../lib/checkout.ts";
import { assertCleanBundle, assetInventory, buildEnvironment, expectedAssets, normalizeArtifacts, PLATFORMS, RELEASE_REPOSITORY, releaseInputs, releaseNotes, verifyChecksums } from "../lib/release.ts";

interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  target_commitish: string;
  assets: { name: string }[];
}

const input = (ctx: Context) => releaseInputs(ctx.args.version ?? "", ctx.args.platforms ?? "linux,win,mac");
const source = (co: Checkout) => Path.join(co.evidence, "source");
const assets = (co: Checkout) => Path.join(co.evidence, "assets");

async function gh(ctx: Context, co: Checkout, ...args: string[]) {
  const token = await ctx.secret("WEAVEWING_RELEASE_GH_TOKEN");
  return ctx.exec(["gh", ...args], { cwd: co.root, env: { ...co.env, GH_TOKEN: token ?? "", GITHUB_TOKEN: "" } }).string();
}

async function findRelease(ctx: Context, co: Checkout): Promise<Release | undefined> {
  const pages: Release[][] = JSON.parse(await gh(ctx, co, "api", `repos/${RELEASE_REPOSITORY}/releases?per_page=100`, "--paginate", "--slurp"));
  return pages.flat().find((release) => release.tag_name === input(ctx).tag);
}

async function build(ctx: Context, co: Checkout, name: string, argv: readonly [string, ...string[]]) {
  const clean = buildEnvironment(`${Path.join(OS.homedir(), ".cargo/bin")}:${co.env.PATH}`, OS.homedir(), "");
  delete clean.TMPDIR;
  return logged(ctx, co, name, ["xwing", "env", "exec", "--repo", co.root, "--scratch", "--", "bash", "-c", 'exec env -C "$1" -i "TMPDIR=$TMPDIR" "${@:2}"', "bash", source(co), ...Object.entries(clean).map(([key, value]) => `${key}=${value}`), ...argv]);
}

async function assertInput(ctx: Context, co: Checkout, published = false) {
  const { tag, platforms } = input(ctx);
  const commit = git(co.root, "rev-parse", "HEAD");
  if (git(co.root, "status", "--porcelain")) throw new Error("Release source must be clean and committed");
  for (const name of [".env", ".env.local"])
    if (FS.existsSync(Path.join(co.root, name))) throw new Error(`Release source must not contain ${name}`);
  if (ctx.args.stage !== "plan") git(co.root, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main");
  const free = FS.statfsSync("/mnt/d");
  if (free.bavail * free.bsize < 30 * 1024 ** 3) throw new Error("D: has less than 30 GiB free. Stop and free space.");
  const repo = JSON.parse(await gh(ctx, co, "api", `repos/${RELEASE_REPOSITORY}`)) as { permissions?: { push?: boolean } };
  if (!repo.permissions?.push) throw new Error(`The gh identity cannot write ${RELEASE_REPOSITORY}`);
  const release = await findRelease(ctx, co);
  if (!published && release && !release.draft) throw new Error(`${tag} is already public`);
  if (platforms.includes("mac") && ctx.args.stage !== "promote")
    await logged(ctx, co, "mac-preflight", ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "moonborn", "set -eu; test $(uname -m) = arm64; available=$(df -k \"$HOME\" | tail -1 | awk '{print $4}'); test \"$available\" -gt 31457280; command -v vp; command -v node; xcrun --find notarytool"]);
  if (ctx.args.stage !== "promote" && (platforms.includes("linux") || platforms.includes("win")))
    await logged(ctx, co, "host-preflight", ["bash", "-c", 'set -eu; command -v cc make pkg-config convert patchelf zip >/dev/null && pkg-config --exists libsecret-1 || { echo "Install prerequisites: sudo apt-get install build-essential pkg-config libsecret-1-dev imagemagick patchelf zip" >&2; exit 1; }']);
  return { commit, tag, platforms };
}

definePipeline({
  name: "Release",
  short: "Build Weavewing desktop and CLI archives, then draft or promote a GitHub release",
  help: "Manual only. plan builds and records the release without GitHub writes. draft creates a private draft. promote verifies uploaded checksums and needs --allow-risk prod.",
  args: [
    ...checkoutArgs,
    { name: "version", type: "string", required: true, description: "Plain release semver" },
    { name: "platforms", type: "string", default: "linux,win,mac", description: "Comma-separated linux,win,mac subset" },
    { name: "stage", type: "string", default: "draft", enum: ["draft", "plan", "promote"], description: "draft, plan or promote" },
    { name: "notes-file", type: "string", description: "Absolute path to release notes to use instead of generated notes" },
  ],
  secrets: ["WEAVEWING_RELEASE_GH_TOKEN", "APPLE_CSC_LINK", "APPLE_CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"].map((name) => ({ name, optional: true })),
  plan(p, run) {
    const version = run.args.version ?? "";
    const { platforms } = releaseInputs(version || "0.0.0", run.args.platforms || "linux,win,mac");
    p.concurrency(new ConcurrencyGroup("weavewing-release", { capacity: 1 }));

    if (run.args.stage === "promote") {
      const promote = p.job("promote").inline().cores(0.25);
      promote.step("publish", async (ctx) => {
        const co = checkout(ctx);
        const { tag, commit } = await assertInput(ctx, co);
        const release = await findRelease(ctx, co);
        if (!release?.draft) throw new Error("Promote requires an existing draft");
        if (release.target_commitish !== commit) throw new Error("The draft target does not match this checkout's commit");
        const names = [...expectedAssets(version, PLATFORMS), "SHA256SUMS"];
        if (release.assets.length !== names.length || names.some((name) => !release.assets.some((asset) => asset.name === name)))
          throw new Error("Draft does not have the complete three-platform release asset set");
        const download = Path.join(co.evidence, "promote-assets");
        FS.mkdirSync(download, { recursive: true });
        await gh(ctx, co, "release", "download", tag, "--repo", RELEASE_REPOSITORY, "--dir", download, "--clobber");
        verifyChecksums(download, names.filter((name) => name !== "SHA256SUMS"), FS.readFileSync(Path.join(download, "SHA256SUMS"), "utf8"));
        await gh(ctx, co, "release", "edit", tag, "--repo", RELEASE_REPOSITORY, "--draft=false", "--latest");
        const url = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${tag}`;
        ctx.log.info(url);
        return { commit, url };
      }).risk("prod").result();
      return;
    }

    const preflight = p.job("preflight", async (ctx) => {
      const co = checkout(ctx);
      const result = await assertInput(ctx, co);
      await logged(ctx, co, "release-tests", ["node", "--test", ".sparkwing/lib/release.test.ts"]);
      FS.writeFileSync(Path.join(co.evidence, "release-input.json"), JSON.stringify({ ...result, version, stage: ctx.args.stage, run: ctx.run.id }, null, 2));
      return result;
    }).inline().cores(0.25);

    const ci = p.job("ci", async (ctx) => {
      const co = checkout(ctx);
      await ctx.runPipeline("ci", "changes", { args: { worktree: co.root, evidence: Path.join(co.evidence, "ci"), full: "true" } });
      return { commit: git(co.root, "rev-parse", "HEAD"), passed: true };
    }).inline().cores(0.25).needs(preflight).startsChildren("ci")
      .memo((ctx) => memoKey("release-ci/v1", checkout(ctx).root, git(checkout(ctx).root, "rev-parse", "HEAD"), checkout(ctx).nodeVersion));

    const bundle = p.job("bundle", async (ctx) => {
      const co = checkout(ctx);
      const { commit } = (await ctx.output(preflight))!;
      if (git(co.root, "rev-parse", "HEAD") !== commit || git(co.root, "status", "--porcelain")) throw new Error("Release source changed after preflight");
      FS.mkdirSync(source(co), { recursive: true });
      await logged(ctx, co, "archive-source", ["bash", "-c", 'set -euo pipefail; git -C "$1" archive "$2" | tar -x -C "$3"', "bash", co.root, commit, source(co)]);
      await build(ctx, co, "install", ["vp", "i", "--frozen-lockfile"]);
      await build(ctx, co, "align-version", ["node", "scripts/update-release-package-versions.ts", version]);
      await build(ctx, co, "bundle", ["vp", "run", "build:desktop:bundle"]);
      return { commit };
    }).inline().cores(8).needs(preflight, ci);

    const clean = p.job("assert-clean-bundle", (ctx) => {
      assertCleanBundle(source(checkout(ctx)));
      return { clean: true };
    }).inline().cores(0.25).needs(bundle);

    const linux = p.job("linux-x64", async (ctx) => {
      const co = checkout(ctx);
      FS.mkdirSync(assets(co), { recursive: true });
      await build(ctx, co, "linux-monitor", ["cargo", "build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml", "--target", "x86_64-unknown-linux-gnu"]);
      const monitor = Path.join(source(co), "release-monitors/linux-x64");
      FS.mkdirSync(monitor, { recursive: true });
      FS.copyFileSync(Path.join(source(co), "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor"), Path.join(monitor, "t3-resource-monitor"));
      await build(ctx, co, "linux-exe", ["node", "apps/server/scripts/cli.ts", "build-exe"]);
      await build(ctx, co, "linux-cli", ["node", "scripts/build-cli-archive.ts", "--platform", "linux", "--arch", "x64", "--version", version, "--resource-monitor-dir", Path.dirname(monitor), "--output-dir", assets(co)]);
      const archive = Path.join(assets(co), `t3-${version}-linux-x64.tar.gz`);
      await build(ctx, co, "linux-cli-smoke", ["node", "scripts/smoke-cli-archive.ts", "--archive", archive, "--expect-version", version]);
      if (platforms.includes("linux")) {
        await build(ctx, co, "linux-desktop", ["vp", "run", "dist:desktop:artifact", "--platform", "linux", "--target", "AppImage", "--arch", "x64", "--build-version", version, "--skip-build", "--output-dir", assets(co), "--verbose"]);
        normalizeArtifacts(assets(co), "linux", version);
        await build(ctx, co, "linux-appimage", ["node", ".sparkwing/lib/release-linux-proof.ts", "--assets", assets(co), "--version", version, "--evidence", co.evidence]);
      }
      return { archive };
    }).inline().cores(8).needs(clean).skipIf(() => !platforms.includes("linux") && !platforms.includes("win"));

    const win = p.job("win-x64", async (ctx) => {
      const co = checkout(ctx);
      const { archive } = (await ctx.output(linux))!;
      await build(ctx, co, "win-rust-target", ["rustup", "target", "add", "x86_64-pc-windows-msvc"]);
      await build(ctx, co, "cargo-xwin", ["cargo", "install", "cargo-xwin", "--version", "0.23.1", "--locked"]);
      await build(ctx, co, "win-monitor", ["cargo", "xwin", "build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml", "--target", "x86_64-pc-windows-msvc"]);
      const monitor = Path.join(source(co), "release-monitors-win/win32-x64");
      FS.mkdirSync(monitor, { recursive: true });
      FS.copyFileSync(Path.join(source(co), "native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe"), Path.join(monitor, "t3-resource-monitor.exe"));
      await build(ctx, co, "win-exe", ["node", "apps/server/scripts/cli.ts", "build-exe", "--target", "win-x64"]);
      await build(ctx, co, "win-cli", ["node", "scripts/build-cli-archive.ts", "--platform", "win", "--arch", "x64", "--version", version, "--resource-monitor-dir", Path.dirname(monitor), "--output-dir", assets(co)]);
      await build(ctx, co, "win-desktop-native", ["node", ".sparkwing/lib/release-windows.ts", "--assets", assets(co), "--version", version, "--wsl-runtime", archive]);
      normalizeArtifacts(assets(co), "win", version);
      return { platform: "win" };
    }).inline().cores(8).needs(linux, clean).skipIf(() => !platforms.includes("win"))
      .concurrency(new ConcurrencyGroup("weavewing-desktop", { capacity: 1 }));

    const mac = p.job("mac", async (ctx) => {
      const co = checkout(ctx);
      const { commit } = (await ctx.output(preflight))!;
      await logged(ctx, co, "mac", ["node", ".sparkwing/lib/release-mac.ts", "--worktree", co.root, "--commit", commit, "--version", version, "--run", ctx.run.id, "--evidence", co.evidence], Object.fromEntries(await Promise.all(["APPLE_CSC_LINK", "APPLE_CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"].map(async (key) => [key, (await ctx.secret(key)) ?? ""]))));
      return { platform: "mac" };
    }).inline().cores(1).needs(preflight, clean).skipIf(() => !platforms.includes("mac"))
      .concurrency(new ConcurrencyGroup("weavewing-release-moonborn", { capacity: 1 }));

    p.job("publish-draft", async (ctx) => {
      const co = checkout(ctx);
      const { commit, tag } = (await ctx.output(preflight))!;
      const names = expectedAssets(version, platforms);
      const dir = assets(co);
      const release = await findRelease(ctx, co);
      if (release && (!release.draft || release.target_commitish !== commit))
        throw new Error("Existing release is public or has a different target commit. Delete its draft before rebuilding.");
      if (ctx.args.stage === "draft" && platforms.length !== PLATFORMS.length && release?.assets.length) {
        const previous = Path.join(co.evidence, "previous-draft-assets");
        FS.mkdirSync(previous, { recursive: true });
        const previousNames = release.assets.map((asset) => asset.name).filter((name) => name !== "SHA256SUMS");
        const allowed = expectedAssets(version, PLATFORMS);
        if (previousNames.some((name) => !allowed.includes(name))) throw new Error("Existing draft has unexpected assets");
        await gh(ctx, co, "release", "download", tag, "--repo", RELEASE_REPOSITORY, "--dir", previous, "--clobber");
        verifyChecksums(previous, previousNames, FS.readFileSync(Path.join(previous, "SHA256SUMS"), "utf8"));
        for (const name of previousNames.filter((name) => !names.includes(name))) {
          FS.copyFileSync(Path.join(previous, name), Path.join(dir, name));
          names.push(name);
        }
        names.sort();
      }
      const inventory = assetInventory(dir, names);
      FS.writeFileSync(Path.join(dir, "SHA256SUMS"), inventory.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""));
      const notes = ctx.args["notes-file"] ? FS.readFileSync(ctx.args["notes-file"], "utf8") : releaseNotes(co.root, version, commit);
      const notesFile = Path.join(co.evidence, "notes.md");
      FS.writeFileSync(notesFile, notes);
      FS.writeFileSync(Path.join(co.evidence, "artifacts.json"), JSON.stringify(assetInventory(dir, [...names, "SHA256SUMS"]), null, 2));
      FS.writeFileSync(Path.join(co.evidence, "release.json"), JSON.stringify({ repository: RELEASE_REPOSITORY, tag, target: commit, title: `Weavewing ${version}`, draft: true, assets: [...names, "SHA256SUMS"], notesFile }, null, 2));
      if (ctx.args.stage === "plan") {
        ctx.log.info(`Plan complete. No GitHub writes. Evidence: ${co.evidence}`);
        return { commit, evidence: co.evidence, assets: [...names, "SHA256SUMS"] };
      }
      await assertInput(ctx, co);
      if (release) {
        if (release.target_commitish !== commit) throw new Error("Existing draft has a different target commit. Delete it before rebuilding.");
        await gh(ctx, co, "release", "edit", tag, "--repo", RELEASE_REPOSITORY, "--draft", "--target", commit, "--title", `Weavewing ${version}`, "--notes-file", notesFile);
      } else {
        await gh(ctx, co, "release", "create", tag, "--repo", RELEASE_REPOSITORY, "--draft", "--target", commit, "--title", `Weavewing ${version}`, "--notes-file", notesFile);
      }
      await gh(ctx, co, "release", "upload", tag, "--repo", RELEASE_REPOSITORY, "--clobber", ...[...names, "SHA256SUMS"].map((name) => Path.join(dir, name)));
      return { commit, evidence: co.evidence };
    }).inline().cores(0.25).needs(preflight, linux, win, mac);
  },
});
