import { randomUUID } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { ConcurrencyGroup, type Context, definePipeline, workDir } from "@sparkwing/sdk";

import { checkout, checkoutArgs, checkoutAt, git, isCommittedCheckout, logged, type Checkout } from "../lib/checkout.ts";
import { APPLE_SIGNING_SECRETS, assertCleanBundle, assertMacSigningNotes, assertPushedCommit, assertTagAbsent, assetInventory, buildEnvironment, draftMacSigning, expectedAssets, macCleanup, macHost, macPreflight, normalizeArtifacts, PLATFORMS, RELEASE_REPOSITORY, releaseInputs, releaseFlags, releaseNotes, verifyChecksums, verifyPromotionAssets } from "../lib/release.ts";

import { smokeCi, verifiedCi } from "../lib/release-ci.ts";

interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  target_commitish: string;
  body: string | null;
  assets: { id: number; name: string }[];
}

const input = (ctx: Pick<Context, "args">) => releaseInputs(ctx.args.version ?? "", ctx.args.platforms ?? "linux,win,mac", ctx.args.channel);
const assets = (co: Checkout) => Path.join(co.evidence, "assets");

async function gh(ctx: Context, co: Checkout, ...args: string[]) {
  const token = await ctx.secret("WEAVEWING_RELEASE_GH_TOKEN");
  return ctx.exec(["gh", ...args], { cwd: co.root, env: { ...co.env, GH_TOKEN: token ?? "", GITHUB_TOKEN: "" } }).string();
}

async function findRelease(ctx: Context, co: Checkout): Promise<Release | undefined> {
  const pages: Release[][] = JSON.parse(await gh(ctx, co, "api", `repos/${RELEASE_REPOSITORY}/releases?per_page=100`, "--paginate", "--slurp"));
  return pages.flat().find((release) => release.tag_name === input(ctx).tag);
}

async function assertNoTag(ctx: Context, co: Checkout) {
  const { tag } = input(ctx);
  const refs = JSON.parse(await gh(ctx, co, "api", `repos/${RELEASE_REPOSITORY}/git/matching-refs/tags/${tag}`));
  assertTagAbsent(tag, refs);
}

async function assertInput(ctx: Context, co: Checkout) {
  const { tag, platforms } = input(ctx);
  if (ctx.args["notes-file"] && !Path.isAbsolute(ctx.args["notes-file"])) throw new Error("--notes-file must be absolute");
  const commit = git(co.root, "rev-parse", "HEAD");
  if (git(co.root, "status", "--porcelain")) throw new Error("Release source must be clean and committed");
  for (const name of [".env", ".env.local"])
    if (FS.existsSync(Path.join(co.root, name))) throw new Error(`Release source must not contain ${name}`);
  if (ctx.args.stage !== "plan") assertPushedCommit(co.root, commit);
  // Checked before any network step, so a missing Mac host is the first failure a run reports.
  const macBuildHost = platforms.includes("mac") && ctx.args.stage !== "promote" ? macHost(await ctx.variable("WEAVEWING_MAC_HOST")) : undefined;
  const free = FS.statfsSync("/mnt/d");
  if (free.bavail * free.bsize < 30 * 1024 ** 3) throw new Error("D: has less than 30 GiB free. Stop and free space.");
  await logged(ctx, co, "release-tools", ["bash", "-c", 'set -eu; export PATH="$HOME/.cargo/bin:$PATH"; for tool in gh tar rustup cargo; do command -v "$tool" >/dev/null || { case "$tool" in rustup|cargo) echo "Install: curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal" >&2;; gh) echo "Install: sudo apt-get install gh" >&2;; tar) echo "Install: sudo apt-get install tar" >&2;; esac; exit 1; }; done']);
  const repo = JSON.parse(await gh(ctx, co, "api", `repos/${RELEASE_REPOSITORY}`)) as { permissions?: { push?: boolean } };
  if (!repo.permissions?.push) throw new Error(`The gh identity cannot write ${RELEASE_REPOSITORY}`);
  const release = await findRelease(ctx, co);
  if (release && !release.draft) throw new Error(`${tag} is already public`);
  await assertNoTag(ctx, co);
  if (git(co.root, "remote").split("\n").includes("upstream"))
    git(co.root, "fetch", "upstream", "main", "--tags");
  try {
    git(co.root, "rev-parse", "--verify", "refs/remotes/upstream/main");
  } catch {
    throw new Error("Missing upstream/main; add the upstream remote and run git fetch upstream main --tags");
  }
  releaseNotes(co.root, input(ctx).version, commit);
  if (macBuildHost)
    await logged(ctx, co, "mac-preflight", ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", macBuildHost, macPreflight(co.nodeVersion)]);
  if (ctx.args.stage !== "promote" && (platforms.includes("linux") || platforms.includes("win")))
    await logged(ctx, co, "host-preflight", ["bash", "-c", 'set -eu; hint="Install prerequisites: sudo apt-get install build-essential pkg-config libsecret-1-dev imagemagick patchelf zip"; for tool in cc make pkg-config convert patchelf zip; do command -v "$tool" >/dev/null || { echo "$hint" >&2; exit 1; }; done; pkg-config --exists libsecret-1 || { echo "$hint" >&2; exit 1; }']);
  if (ctx.args.stage !== "promote" && platforms.includes("win"))
    await logged(ctx, co, "windows-preflight", ["bash", "-c", 'set -eu; for tool in clang lld-link llvm-lib powershell.exe; do command -v "$tool" >/dev/null || { echo "Install Windows cross-build prerequisites: sudo apt-get install clang lld llvm; Windows PowerShell interop is also required" >&2; exit 1; }; done']);
  return { commit, tree: git(co.root, "rev-parse", `${commit}^{tree}`), tag, platforms, channel: input(ctx).channel };
}

export const releasePipeline = definePipeline({
  name: "Release",
  short: "Build Weavewing desktop and CLI archives, then draft or promote a GitHub release",
  help: "Manual only. plan builds and records the release without GitHub writes. draft creates a private draft. promote verifies uploaded checksums and needs --allow-risk prod.",
  args: [
    ...checkoutArgs,
    { name: "version", type: "string", required: true, description: "0.x stable or nightly release semver" },
    { name: "channel", type: "string", default: "stable", enum: ["stable", "test"], description: "Stable release or nightly test prerelease" },
    { name: "platforms", type: "string", default: "linux,win,mac", description: "Comma-separated linux,win,mac subset" },
    { name: "stage", type: "string", default: "draft", enum: ["draft", "plan", "promote"], description: "draft, plan or promote" },
    { name: "force-ci", type: "bool", description: "Force full CI on any channel, bypassing passing evidence (plan/draft only)" },
    { name: "build-only", type: "bool", description: "Only with --stage plan: skip CI for artifact proof" },
    { name: "notes-file", type: "string", description: "Absolute path to release notes to use instead of generated notes" },
    { name: "draft-evidence", type: "string", description: "Required for promote: absolute evidence directory of the draft run" },
  ],
  secrets: [...["WEAVEWING_RELEASE_GH_TOKEN", ...APPLE_SIGNING_SECRETS].map((name) => ({ name, optional: true })), { name: "WEAVEWING_MAC_HOST", optional: true, variable: true }],
  plan(p, run) {
    const version = run.args.version ?? "";
    const { platforms, channel } = releaseInputs(version || (run.args.channel === "test" ? "0.0.0-nightly.20000101.0" : "0.0.0"), run.args.platforms || "linux,win,mac", run.args.channel);
    const buildOnly = run.args["build-only"] === "true";
    if (buildOnly && run.args.stage !== "plan") throw new Error("--build-only is restricted to --stage plan");
    if (run.args["force-ci"] === "true" && (buildOnly || run.args.stage === "promote")) throw new Error("--force-ci requires a plan or draft with CI enabled");
    p.concurrency(new ConcurrencyGroup("weavewing-release", { capacity: 1 }));

    if (run.args.stage === "promote") {
      const promote = p.job("promote").inline().cores(0.25);
      promote.step("publish", async (ctx) => {
        const co = checkout(ctx);
        const { tag, commit } = await assertInput(ctx, co);
        const draftEvidence = ctx.args["draft-evidence"];
        if (!draftEvidence || !Path.isAbsolute(draftEvidence)) throw new Error("Promote requires --draft-evidence <absolute draft run directory>");
        const release = await findRelease(ctx, co);
        if (!release?.draft) throw new Error("Promote requires an existing draft");
        if (release.target_commitish !== commit) throw new Error("The draft target does not match this checkout's commit");
        const names = [...expectedAssets(version, PLATFORMS, channel), "SHA256SUMS"];
        if (release.assets.length !== names.length || names.some((name) => !release.assets.some((asset) => asset.name === name)))
          throw new Error("Draft does not have the complete three-platform release asset set");
        const download = Path.join(co.evidence, "promote-assets");
        FS.mkdirSync(download, { recursive: true });
        await gh(ctx, co, "release", "download", tag, "--repo", RELEASE_REPOSITORY, "--dir", download, "--clobber");
        const appleSigningConfigured = (await Promise.all(APPLE_SIGNING_SECRETS.map((name) => ctx.secret(name)))).some(Boolean);
        const signing = verifyPromotionAssets(download, names.filter((name) => name !== "SHA256SUMS"), draftEvidence, tag, commit, channel, { appleSigningConfigured });
        assertMacSigningNotes(release.body ?? "", signing);
        await assertNoTag(ctx, co);
        await gh(ctx, co, "release", "edit", tag, "--repo", RELEASE_REPOSITORY, "--draft=false", ...releaseFlags(channel, "promote"));
        const ref = JSON.parse(await gh(ctx, co, "api", `repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`));
        const object = ref.object.type === "tag"
          ? JSON.parse(await gh(ctx, co, "api", `repos/${RELEASE_REPOSITORY}/git/tags/${ref.object.sha}`)).object
          : ref.object;
        if (object.type !== "commit" || object.sha !== commit) throw new Error("Published tag does not match the release commit; follow the release rollback procedure");
        const url = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${tag}`;
        ctx.log.info(url);
        return { commit, url };
      }).risk("prod").result();
      return;
    }

    const preflight = p.job("preflight", async (ctx) => {
      const co = checkout(ctx);
      const result = await assertInput(ctx, co);
      FS.writeFileSync(Path.join(co.evidence, "release-input.json"), JSON.stringify({ ...result, version, stage: ctx.args.stage, buildOnly, run: ctx.run.id }, null, 2));
      await logged(ctx, co, "release-tests", ["node", "--test", ".sparkwing/lib/release.test.ts", ".sparkwing/lib/release-mac-signing.test.ts", ".sparkwing/lib/release-ci.test.ts", ".sparkwing/jobs/release.test.ts"]);
      return result;
    }).inline().cores(0.25);

    const ci = !buildOnly && (channel === "stable" || run.args["force-ci"] === "true") ? p.job("ci", async (ctx) => {
      const co = checkout(ctx);
      const pass = await verifiedCi(co, ctx.run.id, async () => {
        await ctx.runPipeline("ci", "changes", { args: { worktree: co.root, evidence: Path.join(co.evidence, "ci"), full: "true" } });
      }, { force: ctx.args["force-ci"] === "true" });
      ctx.log.info(`Full CI passed for tree ${pass.tree}; evidence from ${pass.run}: ${pass.evidence}`);
      return pass;
    }).inline().cores(0.25).needs(preflight).startsChildren("ci") : undefined;
    const ciDeps = ci ? [ci] : [];

    const localBuild = p.job("build", async (ctx) => {
      const co = checkout(ctx);
      const { commit, tree } = (await ctx.output(preflight))!;
      if (git(co.root, "rev-parse", "HEAD") !== commit || git(co.root, "status", "--porcelain"))
        throw new Error("Release source changed after preflight");
      const built = await ctx.runPipeline<{ commit: string; tree: string }>("release-build", "build", {
        branch: commit,
        args: { commit, tree, version, channel, platforms: platforms.join(","), evidence: co.evidence },
      });
      if (built.commit !== commit || built.tree !== tree) throw new Error("Release build provenance differs from preflight");
      return built;
    }).inline().cores(0.25).needs(preflight, ...ciDeps).startsChildren("release-build");

    const mac = p.job("mac", async (ctx) => {
      const co = checkout(ctx);
      const { commit } = (await ctx.output(preflight))!;
      const host = macHost(await ctx.variable("WEAVEWING_MAC_HOST"));
      const secrets = Object.fromEntries(await Promise.all(APPLE_SIGNING_SECRETS.map(async (key) => [key, (await ctx.secret(key)) ?? ""])));
      const attempt = `${ctx.run.id}-${randomUUID()}`;
      const cleanup = await ctx.cleanup({
        argv: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, macCleanup(attempt)],
        description: "Remove the current Mac release workspace",
      });
      // Node would print the secret payload it pipes to ssh while these are set.
      await logged(ctx, co, "mac", ["node", ".sparkwing/lib/release-mac.ts", "--worktree", co.root, "--commit", commit, "--version", version, "--channel", channel, "--run", attempt, "--evidence", co.evidence, "--host", host], { ...secrets, NODE_DEBUG: "", NODE_DEBUG_NATIVE: "", NODE_OPTIONS: "" });
      await cleanup.unregister();
      return { platform: "mac" };
    }).inline().cores(1).needs(preflight, ...ciDeps).skipIf(() => !platforms.includes("mac"))
      .concurrency(new ConcurrencyGroup("weavewing-release-mac-host", { capacity: 1 }));

    p.job("publish-draft", async (ctx) => {
      const co = checkout(ctx);
      const { commit, tag, tree } = (await ctx.output(preflight))!;
      const names = expectedAssets(version, platforms, channel);
      const dir = assets(co);
      const release = await findRelease(ctx, co);
      if (release && (!release.draft || release.target_commitish !== commit))
        throw new Error("Existing release is public or has a different target commit. Delete its draft before rebuilding.");
      if (ctx.args.stage === "draft" && platforms.length !== PLATFORMS.length && release?.assets.length) {
        const previous = Path.join(co.evidence, "previous-draft-assets");
        FS.mkdirSync(previous, { recursive: true });
        const previousNames = release.assets.map((asset) => asset.name).filter((name) => name !== "SHA256SUMS");
        const allowed = expectedAssets(version, PLATFORMS, channel);
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
      // The draft's Mac assets may come from this run or an earlier draft; their bytes select the signing.
      const mac = draftMacSigning(dir, names);
      const generated = releaseNotes(co.root, version, commit, { draftBody: release?.body, notesFile: ctx.args["notes-file"], macSigning: mac });
      const smokeNotice = "Smoke-tested build: full test suites run only before stable releases.";
      const notes = ci || buildOnly || generated.includes(smokeNotice) ? generated : `${smokeNotice}\n\n${generated}`;
      const notesFile = Path.join(co.evidence, "notes.md");
      FS.writeFileSync(notesFile, notes);
      FS.writeFileSync(Path.join(co.evidence, "artifacts.json"), JSON.stringify(assetInventory(dir, [...names, "SHA256SUMS"]), null, 2));
      const ciEvidence = buildOnly ? undefined : ci ? await ctx.output(ci) : smokeCi(co, ctx.run.id, channel);
      FS.writeFileSync(Path.join(co.evidence, "release.json"), JSON.stringify({ repository: RELEASE_REPOSITORY, tag, target: commit, title: `Weavewing ${version}`, channel, prerelease: channel === "test", latest: false, draft: true, ci: buildOnly ? "skipped: build-only plan" : ci ? "passed" : `smoke: ${channel} channel`, ciEvidence, macSigning: mac ?? "no macOS assets", tree, assets: [...names, "SHA256SUMS"], notesFile }, null, 2));
      if (ctx.args.stage === "plan") {
        ctx.log.info(`Plan complete. No GitHub writes. Evidence: ${co.evidence}`);
        return { commit, evidence: co.evidence, assets: [...names, "SHA256SUMS"] };
      }
      await assertInput(ctx, co);
      if (release) {
        if (release.target_commitish !== commit) throw new Error("Existing draft has a different target commit. Delete it before rebuilding.");
        await gh(ctx, co, "release", "edit", tag, "--repo", RELEASE_REPOSITORY, "--draft", "--target", commit, "--title", `Weavewing ${version}`, ...releaseFlags(channel, "draft"), "--notes-file", notesFile);
        for (const asset of release.assets.filter((asset) => ![...names, "SHA256SUMS"].includes(asset.name)))
          await gh(ctx, co, "api", "--method", "DELETE", `repos/${RELEASE_REPOSITORY}/releases/assets/${asset.id}`);
      } else {
        await gh(ctx, co, "release", "create", tag, "--repo", RELEASE_REPOSITORY, "--draft", "--target", commit, "--title", `Weavewing ${version}`, "--notes-file", notesFile, ...releaseFlags(channel, "draft"));
      }
      await gh(ctx, co, "release", "upload", tag, "--repo", RELEASE_REPOSITORY, "--clobber", ...[...names, "SHA256SUMS"].map((name) => Path.join(dir, name)));
      return { commit, evidence: co.evidence };
    }).inline().cores(0.25).needs(preflight, ...ciDeps, localBuild, mac);
  },
});

const source = (co: Checkout) => Path.join(Path.dirname(co.root), "release-source");
const scratch = (co: Checkout) => Path.join(Path.dirname(co.root), "release-tmp");

function buildCheckout(ctx: Context) {
  const root = FS.realpathSync(workDir());
  if (!isCommittedCheckout(root))
    throw new Error("Release build requires a Sparkwing-owned committed checkout. Run the release pipeline.");
  const co = checkoutAt(ctx, root);
  const workspace = Path.dirname(root);
  const evidence = FS.realpathSync(co.evidence);
  if (workspace === evidence || workspace.startsWith(evidence + Path.sep) || evidence.startsWith(workspace + Path.sep))
    throw new Error("Release evidence must be outside the Sparkwing build workspace");
  return co;
}

function requireBundle(ctx: Context, bundled: { workspace: string } | undefined) {
  const co = buildCheckout(ctx);
  // A step selection can omit bundling, or an interrupted attempt can lose its workspace.
  if (bundled?.workspace !== co.root || !FS.existsSync(source(co)) || !FS.existsSync(scratch(co)))
    throw new Error("Release build workspace is missing or changed after bundling. Start a fresh release run.");
  return co;
}

function build(ctx: Context, co: Checkout, name: string, argv: readonly [string, ...string[]]) {
  const clean = buildEnvironment(`${Path.join(OS.homedir(), ".cargo/bin")}:${co.env.PATH}`, OS.homedir(), scratch(co), input(ctx).channel);
  return logged(ctx, co, name, ["env", "-C", source(co), "-i", ...Object.entries(clean).map(([key, value]) => `${key}=${value}`), ...argv]);
}

export const releaseBuildPipeline = definePipeline({
  name: "ReleaseBuild",
  short: "Internal committed-source build for the release pipeline",
  args: ["commit", "tree", "version", "channel", "platforms", "evidence"].map((name) => ({ name, type: "string", required: true })),
  plan(p, run) {
    const version = run.args.version || (run.args.channel === "test" ? "0.0.0-nightly.20000101.0" : "0.0.0");
    const { platforms, channel } = releaseInputs(version, run.args.platforms || "linux,win,mac", run.args.channel);
    const keepDesktopAssets = (co: Checkout, staging: string, platform: "linux" | "win") => {
      const names = expectedAssets(version, [platform], channel).filter((name) =>
        name !== "release-metadata.json" && (platform !== "linux" || name !== `t3-${version}-linux-x64.tar.gz`));
      for (const name of names) FS.copyFileSync(Path.join(staging, name), Path.join(assets(co), name));
      const metadata = Path.join(scratch(co), "build-metadata", platform);
      if (FS.existsSync(metadata)) FS.cpSync(metadata, Path.join(co.evidence, "build-metadata", platform), { recursive: true });
    };

    const packageRelease = p.job("build").inline().cores(8);
    if (platforms.includes("win")) packageRelease.concurrency(new ConcurrencyGroup("weavewing-desktop", { capacity: 1 }));

    const bundle = packageRelease.step("bundle", async (ctx) => {
      const co = buildCheckout(ctx);
      const commit = git(co.root, "rev-parse", "HEAD");
      const tree = git(co.root, "rev-parse", "HEAD^{tree}");
      if (commit !== ctx.args.commit || tree !== ctx.args.tree) throw new Error("Release build checkout differs from preflight");
      FS.mkdirSync(source(co));
      FS.mkdirSync(scratch(co));
      await logged(ctx, co, "archive-source", ["bash", "-c", 'set -euo pipefail; git -C "$1" archive "$2" | tar -x -C "$3"', "bash", co.root, commit, source(co)]);
      await build(ctx, co, "install", ["vp", "i", "--frozen-lockfile"]);
      await build(ctx, co, "align-version", ["node", "scripts/update-release-package-versions.ts", version]);
      await build(ctx, co, "bundle", ["vp", "run", "build:desktop:bundle"]);
      return { commit, tree, workspace: co.root };
    }).result();

    const clean = packageRelease.step("assert-clean-bundle", async (ctx) => {
      const co = requireBundle(ctx, ctx.stepOutput(bundle));
      assertCleanBundle(source(co));
      const launcher = Path.join(scratch(co), "launcher");
      await build(ctx, co, "release-metadata", ["node", "scripts/build-npm-launcher.ts", "--version", version, "--output-dir", launcher]);
      FS.mkdirSync(assets(co), { recursive: true });
      FS.copyFileSync(Path.join(launcher, "t3/package.json"), Path.join(assets(co), "release-metadata.json"));
      return { clean: true };
    }).needs(bundle);

    const linux = packageRelease.step("linux-x64", async (ctx) => {
      const co = requireBundle(ctx, ctx.stepOutput(bundle));
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
        const staging = Path.join(scratch(co), "linux-assets");
        await build(ctx, co, "linux-desktop", ["vp", "run", "dist:desktop:artifact", "--platform", "linux", "--target", "AppImage", "--arch", "x64", "--build-version", version, "--skip-build", "--output-dir", staging, "--verbose"]);
        normalizeArtifacts(staging, "linux", version, channel);
        await build(ctx, co, "linux-appimage", ["node", ".sparkwing/lib/release-linux-proof.ts", "--assets", staging, "--version", version, "--evidence", co.evidence]);
        keepDesktopAssets(co, staging, "linux");
      }
      return { archive };
    }).needs(bundle, clean).skipIf(() => !platforms.includes("linux") && !platforms.includes("win"));

    packageRelease.step("win-x64", async (ctx) => {
      const co = requireBundle(ctx, ctx.stepOutput(bundle));
      const { archive } = ctx.stepOutput(linux)!;
      await build(ctx, co, "win-rust-target", ["rustup", "target", "add", "x86_64-pc-windows-msvc"]);
      await build(ctx, co, "cargo-xwin", ["cargo", "install", "cargo-xwin", "--version", "0.23.1", "--locked"]);
      await build(ctx, co, "win-monitor", ["cargo", "xwin", "build", "--locked", "--release", "--manifest-path", "native/resource-monitor/Cargo.toml", "--target", "x86_64-pc-windows-msvc"]);
      const monitor = Path.join(source(co), "release-monitors-win/win32-x64");
      FS.mkdirSync(monitor, { recursive: true });
      FS.copyFileSync(Path.join(source(co), "native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe"), Path.join(monitor, "t3-resource-monitor.exe"));
      await build(ctx, co, "win-exe", ["node", "apps/server/scripts/cli.ts", "build-exe", "--target", "win-x64"]);
      const staging = Path.join(scratch(co), "win-assets");
      await build(ctx, co, "win-cli", ["node", "scripts/build-cli-archive.ts", "--platform", "win", "--arch", "x64", "--version", version, "--resource-monitor-dir", Path.dirname(monitor), "--output-dir", staging]);
      await build(ctx, co, "win-desktop-native", ["node", ".sparkwing/lib/release-windows.ts", "--assets", staging, "--version", version, "--wsl-runtime", archive]);
      normalizeArtifacts(staging, "win", version, channel);
      keepDesktopAssets(co, staging, "win");
      return { platform: "win" };
    }).needs(bundle, linux, clean).skipIf(() => !platforms.includes("win"));
  },
});
