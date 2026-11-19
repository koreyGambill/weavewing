import assert from "node:assert/strict";
import * as CP from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import * as Release from "./release.ts";
import { releaseVersionFromTag } from "../../packages/shared/src/releaseIdentity.ts";
import { assertCleanBundle, buildEnvironment, expectedAssets, releaseInputs, renderReleaseNotes, verifyChecksums } from "./release.ts";

test("packaged updater config must name the fork even when its bundle contains the fork string", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-updater-"));
  const file = Path.join(root, "app-update.yml");
  try {
    FS.writeFileSync(Path.join(root, "main.js"), 'const repository="koreyGambill/weavewing";');
    for (const config of ["provider: github\nowner: pingdotgg\nrepo: t3code\n", "provider: github\nowner: koreyGambill\nrepo: t3code\n", "provider: generic\nowner: koreyGambill\nrepo: weavewing\n"]) {
      FS.writeFileSync(file, config);
      assert.throws(() => Release.assertUpdaterConfig(file), /updater/i);
    }
    FS.writeFileSync(file, "provider: github\nowner: koreyGambill\nrepo: weavewing\nreleaseType: release\n");
    Release.assertUpdaterConfig(file);
    assert.throws(() => Release.assertUpdaterConfig(Path.join(root, "missing.yml")));
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

test("notes identify source and changes and explain unsigned installs", () => {
  const source = { version: "1.0.0", commit: "abcdef", upstreamCommit: "123456", upstreamVersion: "v0.1.9", changes: ["Merge branch 't3-release'", "fix(server): preserve history"] };
  const first = renderReleaseNotes(source);
  assert.match(first, /First Weavewing release/);
  assert.match(first, /Includes upstream T3 Code through `123456` \(`v0.1.9`\)/);
  assert.match(first, /- Merge branch 't3-release'/);
  assert.match(first, /System Settings → Privacy & Security → Open Anyway/);
  assert.match(first, /xattr -dr com\.apple\.quarantine \/Applications\/Weavewing\.app/);
  assert.match(first, /Unsigned mac builds don't auto-update/);
  assert.match(first, /More info → Run anyway/);
  assert.match(renderReleaseNotes({ ...source, previousTag: "weavewing-v0.9.0" }), /Changes since weavewing-v0\.9\.0/);
});

test("releaseNotes caps first-release merges and preserves edited draft notes", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-notes-"));
  const git = (...args: string[]) => CP.execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input: "" }).trim();
  try {
    git("init", "--initial-branch=main");
    const tree = git("mktree");
    const base = git("commit-tree", tree, "-m", "upstream");
    git("update-ref", "refs/remotes/upstream/main", base);
    git("tag", "--no-sign", "v0.1.9", base);
    git("tag", "--no-sign", "v0.1.10-nightly.20261116.4774", base);
    let head = git("commit-tree", tree, "-p", base, "-m", "internal setup");
    for (let i = 0; i < 43; i++) {
      const feature = git("commit-tree", tree, "-p", head, "-m", `feature ${i}`);
      head = git("commit-tree", tree, "-p", head, "-p", feature, "-m", `Merge feature ${i}`);
    }
    const upstream = git("commit-tree", tree, "-p", base, "-m", "upstream advance");
    git("update-ref", "refs/remotes/upstream/main", upstream);
    head = git("commit-tree", tree, "-p", head, "-p", upstream, "-m", "Merge feature upstream");
    const first = Release.releaseNotes(root, "1.0.0", head);
    assert.equal(Release.releaseNotes(root, "1.0.0", head, { draftBody: "Human-edited notes" }), "Human-edited notes");
    assert.equal((first.match(/^- Merge feature /gm) ?? []).length, 40);
    assert.doesNotMatch(first, /internal setup|nightly/);
    assert.match(first, /`v0\.1\.9`/);
    assert.ok(first.includes(`https://github.com/koreyGambill/weavewing/compare/${base}...${head}`));
    git("tag", "--no-sign", "weavewing-v1.0.0", head);
    const next = git("commit-tree", tree, "-p", head, "-m", "fix: preserve history");
    assert.match(Release.releaseNotes(root, "1.0.1", next), /Changes since weavewing-v1\.0\.0:\n\n- fix: preserve history/);
    assert.equal(Release.releaseNotes(root, "1.0.1", next, { draftBody: "Human-edited notes" }), "Human-edited notes");
    const notes = Path.join(root, "notes.md");
    FS.writeFileSync(notes, "Explicit replacement");
    assert.equal(Release.releaseNotes(root, "1.0.1", next, { draftBody: "Keep", notesFile: notes }), "Explicit replacement");
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

test("release inputs reject non-stable versions and unknown or duplicate platforms", () => {
  for (const version of ["v0.1.0", "0.1.0-beta", "00.1.0", "0.1", "0.1.0+build"])
    assert.throws(() => releaseInputs(version, "linux"), /plain semver/);
  for (const version of ["1.0.0", "2.3.4", "10.0.0"])
    assert.throws(() => releaseInputs(version, "linux"), /above 0\.x/);
  for (const platforms of ["", "linux,linux", "linux,android", "linux,"])
    assert.throws(() => releaseInputs("0.1.0", platforms));
  assert.equal(releaseInputs("0.1.0", "mac,win").tag, "weavewing-v0.1.0");
  assert.equal(releaseInputs("0.12.3", "linux").version, "0.12.3");
  assert.equal(expectedAssets("0.1.0", ["linux", "win", "mac"]).length, 15);
});

test("an exact existing tag refuses a release, including a draft rerun", () => {
  const tag = "weavewing-v1.0.0";
  assert.throws(() => Release.assertTagAbsent(tag, [{ ref: `refs/tags/${tag}` }]), /already exists/);
  Release.assertTagAbsent(tag, []);
  Release.assertTagAbsent(tag, [{ ref: `refs/tags/${tag}-old` }]);
});

test("the pushed-commit check refreshes a stale origin/main before deciding", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-origin-"));
  const git = (repo: string, ...args: string[]) => CP.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", input: "" }).trim();
  try {
    const remote = Path.join(root, "remote");
    const local = Path.join(root, "local");
    FS.mkdirSync(remote);
    git(remote, "init", "--initial-branch=main");
    const tree = git(remote, "mktree");
    const base = git(remote, "commit-tree", tree, "-m", "base");
    git(remote, "update-ref", "refs/heads/main", base);
    git(root, "clone", remote, local);
    const next = git(remote, "commit-tree", tree, "-p", base, "-m", "newly pushed");
    git(remote, "update-ref", "refs/heads/main", next);
    assert.equal(git(local, "rev-parse", "refs/remotes/origin/main"), base);
    Release.assertPushedCommit(local, next);
    assert.equal(git(local, "rev-parse", "refs/remotes/origin/main"), next);
    git(remote, "update-ref", "refs/heads/main", base);
    assert.throws(() => Release.assertPushedCommit(local, next));
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

test("Mac preflight refuses missing managed Node with an install hint", () => {
  const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-mac-tools-"));
  try {
    const bin = Path.join(home, ".local/share/vite-plus/bin");
    FS.mkdirSync(bin, { recursive: true });
    for (const name of ["vp", "cargo", "rustup", "xcrun"])
      FS.writeFileSync(Path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = CP.spawnSync("/bin/sh", ["-c", Release.macPreflight("26.13.1")], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /vp env install 26\.13\.1/);
    assert.match(result.stderr, /js_runtime\/node\/26\.13\.1\/bin\/node/);
    const managed = Path.join(home, ".local/share/vite-plus/js_runtime/node/26.13.1/bin");
    FS.mkdirSync(managed, { recursive: true });
    FS.writeFileSync(Path.join(managed, "node"), "#!/bin/sh\necho v26.13.1\n", { mode: 0o755 });
    FS.writeFileSync(Path.join(bin, "node"), "#!/bin/sh\necho v26.7.0\n", { mode: 0o755 });
    FS.writeFileSync(Path.join(bin, "uname"), "#!/bin/sh\necho arm64\n", { mode: 0o755 });
    const installed = CP.spawnSync("/bin/sh", ["-c", Release.macPreflight("26.13.1")], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /\.local\/share\/vite-plus\/js_runtime\/node\/26\.13\.1/);
  } finally {
    FS.rmSync(home, { recursive: true });
  }
});

test("Mac job startup removes cancelled run directories and preserves unrelated files", () => {
  const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-mac-cleanup-"));
  try {
    const base = Path.join(home, "weavewing-release");
    FS.mkdirSync(Path.join(base, "run-cancelled"), { recursive: true });
    FS.writeFileSync(Path.join(base, "run-cancelled/certificate.p12"), "old signing material");
    FS.mkdirSync(Path.join(base, "keep"));
    CP.execFileSync("/bin/sh", ["-c", Release.macStartup("run-current")], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
    assert.equal(FS.existsSync(Path.join(base, "run-cancelled")), false);
    assert.equal(FS.existsSync(Path.join(base, "run-current/source")), true);
    assert.equal(FS.existsSync(Path.join(base, "keep")), true);
  } finally {
    FS.rmSync(home, { recursive: true });
  }
});

test("promotion checksums reject missing assets, duplicates and modified bytes", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-checksums-"));
  try {
    FS.writeFileSync(Path.join(root, "app.zip"), "release bytes");
    const line = `${Crypto.createHash("sha256").update("release bytes").digest("hex")}  app.zip\n`;
    verifyChecksums(root, ["app.zip"], line);
    assert.throws(() => verifyChecksums(root, ["app.zip", "missing.dmg"], line));
    assert.throws(() => verifyChecksums(root, ["app.zip"], line + line));
    FS.writeFileSync(Path.join(root, "app.zip"), "tampered");
    assert.throws(() => verifyChecksums(root, ["app.zip"], line), /Checksum mismatch/);
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

test("promotion enforces channel CI policy and commit-bound checksums", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-promote-"));
  try {
    const local = Path.join(root, "draft");
    const downloaded = Path.join(root, "downloaded");
    FS.mkdirSync(Path.join(local, "assets"), { recursive: true });
    FS.mkdirSync(downloaded);
    const sums = (bytes: string) => `${Crypto.createHash("sha256").update(bytes).digest("hex")}  app.zip\n`;
    FS.writeFileSync(Path.join(local, "release.json"), JSON.stringify({ repository: "koreyGambill/weavewing", tag: "weavewing-v1.0.0", target: "abc123", ci: "passed", draft: true }));
    FS.writeFileSync(Path.join(local, "assets/app.zip"), "original");
    FS.writeFileSync(Path.join(local, "assets/SHA256SUMS"), sums("original"));
    FS.writeFileSync(Path.join(downloaded, "app.zip"), "replaced");
    FS.writeFileSync(Path.join(downloaded, "SHA256SUMS"), sums("replaced"));
    assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123"), /Checksum|SHA256SUMS/);
    FS.writeFileSync(Path.join(downloaded, "app.zip"), "original");
    FS.writeFileSync(Path.join(downloaded, "SHA256SUMS"), sums("original"));
    Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123");
    assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "wrong-sha"), /evidence/);
    FS.writeFileSync(Path.join(local, "release.json"), JSON.stringify({ repository: "koreyGambill/weavewing", tag: "weavewing-v1.0.0", target: "abc123", ci: "skipped: build-only plan", draft: true }));
    assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123"), /CI-verified/);
    const writeEvidence = (channel: string, ci: string) => FS.writeFileSync(Path.join(local, "release.json"), JSON.stringify({ repository: "koreyGambill/weavewing", tag: "weavewing-v1.0.0", target: "abc123", channel, ci, draft: true }));
    writeEvidence("test", "smoke: test channel");
    Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123", "test");
    assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123", "stable"), /evidence/);
    writeEvidence("stable", "smoke: test channel");
    assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123", "stable"), /CI-verified/);
    writeEvidence("test", "passed");
    Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123", "test");
    assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123", "stable"), /evidence/);
    for (const ci of ["skipped: build-only plan", "smoke: stable channel", "smoke: nightly channel", "failed"]) {
      writeEvidence("test", ci);
      assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123", "test"), /CI-verified/);
    }
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

test("bundle boundary rejects baked analytics, OTLP endpoints and wrapped tracing defaults", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-bundle-"));
  try {
    for (const dir of ["apps/server/dist", "apps/web/dist", "apps/desktop/dist-electron"]) {
      FS.mkdirSync(Path.join(root, dir), { recursive: true });
      FS.writeFileSync(Path.join(root, dir, "main.js"), 'const repository="koreyGambill/weavewing";');
    }
    assertCleanBundle(root);
    const probes = ["pk_live_abc123", "https://relay.t3.codes", "https://api.axiom.co/v1/traces", "__T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__", 'tracesUrl:readBuildTimeValue("https://telemetry.example/traces")', 'tracesToken:h(`arbitrary-token`)', "analyticsEnabled: true", "phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m", "https://us.i.posthog.com", "https://ingest.t3.codes", 'endpoint="https://collector.example/v1/traces"', 'endpoint="http://collector.example:4318"', 'tracesToken:f(g("t0k3n"))', '"tracesToken":f({value:"t0k3n"})', 'tracesUrl:f(g("https://collector.example"))', 'enabled:Boolean("T3CODE_TELEMETRY_ENABLED").pipe(withDefault(true))', 'enabled:B("T3CODE_TELEMETRY_ENABLED").pipe(D(!0))', 'enabled:withDefault(Boolean("T3CODE_TELEMETRY_ENABLED"),!0)', 'env.T3CODE_TELEMETRY_ENABLED ?? "true"', 'env["T3CODE_TELEMETRY_ENABLED"]||!0'];
    for (const value of probes) {
      FS.writeFileSync(Path.join(root, "apps/server/dist/main.js"), value);
      assert.throws(() => assertCleanBundle(root), value);
    }
    FS.writeFileSync(Path.join(root, "apps/server/dist/main.js"), 'tracesToken:f(g("")),tracesUrl:f(""),enabled:Boolean("T3CODE_TELEMETRY_ENABLED").pipe(withDefault(false))');
    assertCleanBundle(root);
    const env = buildEnvironment("/usr/bin", "/home/build", "/tmp/build");
    assert.equal(env.T3CODE_DESKTOP_UPDATE_REPOSITORY, "koreyGambill/weavewing");
    assert.equal(env.T3CODE_CLERK_PUBLISHABLE_KEY, undefined);
    assert.equal(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN, undefined);
    assert.equal(env.GITHUB_REPOSITORY, undefined);
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});


test("test releases require the nightly format and retain the 0.x guard", () => {
  const version = "0.2.0-nightly.20261117.1";
  assert.equal(releaseInputs(version, "linux", "test").tag, `weavewing-v${version}`);
  assert.equal(releaseInputs("0.1.0", "linux").channel, "stable");
  for (const value of ["0.2.0", "0.2.0-test.20261117.1", "0.2.0-nightly.2026117.1", "0.2.0-nightly.20261117.01", "0.2.0-nightly.20261117.1+build"])
    assert.throws(() => releaseInputs(value, "linux", "test"), /nightly/);
  assert.throws(() => releaseInputs(version, "linux", "stable"), /plain semver/);
  assert.throws(() => releaseInputs("0.1.0", "linux", "nightly"), /channel/);
  for (const value of ["1.0.0-nightly.20261117.1", "2.3.4-nightly.20261117.1"])
    assert.throws(() => releaseInputs(value, "linux", "test"), /above 0\.x/);
});

test("channel feeds and GitHub flags agree for draft and promotion", () => {
  for (const channel of ["stable", "test"] as const) {
    const feed = channel === "test" ? "nightly" : "latest";
    const names = expectedAssets("0.2.0-nightly.20261117.1", ["linux", "win", "mac"], channel);
    assert.deepEqual(names.filter((name) => name.endsWith(".yml")), [`${feed}-linux.yml`, `${feed}-mac.yml`, `${feed}.yml`]);
    assert.equal(buildEnvironment("/bin", "/build", "/tmp", channel).T3CODE_DESKTOP_CHANNEL, feed);
    assert.deepEqual(Release.releaseFlags(channel, "draft"), channel === "test" ? ["--prerelease", "--latest=false"] : ["--prerelease=false", "--latest=false"]);
    assert.deepEqual(Release.releaseFlags(channel, "promote"), channel === "test" ? ["--prerelease", "--latest=false"] : ["--prerelease=false", "--latest"]);
  }
});

test("test AppImage normalization rewrites the nightly feed", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-nightly-"));
  try {
    FS.writeFileSync(Path.join(root, "T3-Code-Nightly-x86_64.AppImage"), "image");
    FS.writeFileSync(Path.join(root, "nightly-linux.yml"), "path: T3-Code-Nightly-x86_64.AppImage\n");
    Release.normalizeArtifacts(root, "linux", "0.2.0-nightly.20261117.1", "test");
    assert.match(FS.readFileSync(Path.join(root, "nightly-linux.yml"), "utf8"), /Weavewing-0\.2\.0-nightly\.20261117\.1-x86_64\.AppImage/);
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});


test("fork nightly tags keep their release version", () => {
  assert.equal(releaseVersionFromTag("weavewing-v0.2.0-nightly.20261117.1"), "0.2.0-nightly.20261117.1");
  assert.equal(releaseVersionFromTag("v0.2.0-nightly.20261117.1"), undefined);
});
