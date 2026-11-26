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

test("notes identify source and changes and explain the macOS install for its signing", () => {
  const source = { version: "1.0.0", commit: "abcdef", upstreamCommit: "123456", upstreamVersion: "v0.1.9", changes: ["Merge branch 't3-release'", "fix(server): preserve history"] };
  const first = renderReleaseNotes({ ...source, macSigning: "ad-hoc" });
  assert.match(first, /First Weavewing release/);
  assert.match(first, /Includes upstream T3 Code through `123456` \(`v0.1.9`\)/);
  assert.match(first, /- Merge branch 't3-release'/);
  assert.match(first, /System Settings → Privacy & Security → Open Anyway/);
  assert.match(first, /xattr -dr com\.apple\.quarantine \/Applications\/Weavewing\.app/);
  assert.match(first, /Unsigned mac builds don't auto-update/);
  assert.match(first, /More info → Run anyway/);
  assert.match(first, /All desktop builds in this release are unsigned/);
  const signed = renderReleaseNotes({ ...source, macSigning: "developer-id" });
  assert.doesNotMatch(signed, /Unsigned mac builds|xattr|Open Anyway|All desktop builds in this release are unsigned/);
  assert.match(signed, /signed with a Developer ID, notarized by Apple, and updates itself/);
  assert.match(signed, /earlier unsigned Weavewing build, install this one by hand once, because macOS will not update an ad-hoc signed app/);
  assert.match(signed, /ask again for permissions it granted the earlier build/);
  assert.match(signed, /Linux and Windows builds in this release are unsigned/);
  assert.match(renderReleaseNotes({ ...source, previousTag: "weavewing-v0.9.0" }), /Changes since weavewing-v0\.9\.0/);
  const noMac = renderReleaseNotes({ ...source, macSigning: undefined });
  assert.doesNotMatch(noMac, /macOS|DMG|xattr/);
  assert.match(noMac, /Linux and Windows builds in this release are unsigned/);
});

test("draft reruns replace only the generated signing section, so edited notes keep their text without stale macOS claims", () => {
  const unsigned = `Hand-written intro.\n\n${Release.macSigningSection("ad-hoc")}\n\nHand-written outro.\n`;
  const signed = Release.withMacSigningSection(unsigned, "developer-id");
  assert.equal(signed, `Hand-written intro.\n\n${Release.macSigningSection("developer-id")}\n\nHand-written outro.\n`);
  assert.doesNotMatch(signed, /Unsigned mac builds/);
  assert.equal(Release.withMacSigningSection(signed, "ad-hoc"), unsigned);
  assert.doesNotMatch(Release.withMacSigningSection(signed, undefined), /macOS arm64/);
  assert.equal(Release.withMacSigningSection("Edited without a section", "developer-id"), `Edited without a section\n\n${Release.macSigningSection("developer-id")}\n`);
  const start = "<!-- weavewing:macos-signing -->";
  const end = "<!-- /weavewing:macos-signing -->";
  const malformed = [`${unsigned}${Release.macSigningSection("ad-hoc")}`, `${start} unterminated`, `stray ${end}`, `${end}\n${start}`, `${end}${start}`, `${unsigned}${end}`];
  for (const notes of malformed) {
    assert.throws(() => Release.withMacSigningSection(notes, "ad-hoc"), /exactly one .* pair in that order/);
    assert.throws(() => Release.assertMacSigningNotes(notes, "ad-hoc"), /exactly one .* pair in that order/);
  }
  for (const claim of ["Unsigned mac builds don't auto-update.", "All desktop builds in this release are unsigned.", "The macOS build is Developer ID signed and notarized."]) {
    assert.throws(() => Release.withMacSigningSection(`${claim}\n`, "developer-id"), /outside the generated signing section; remove that text/);
    assert.throws(() => Release.withMacSigningSection(`${unsigned}${claim}\n`, "developer-id"), /outside the generated signing section/);
  }
  Release.assertMacSigningNotes(signed, "developer-id");
  assert.throws(() => Release.assertMacSigningNotes(`${signed}All desktop builds in this release are unsigned.\n`, "developer-id"), /outside the generated signing section/);
  assert.throws(() => Release.assertMacSigningNotes(unsigned, "developer-id"), /does not match/);
  assert.throws(() => Release.assertMacSigningNotes("No section", undefined), /lack the generated macOS signing section/);
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
    const edited = `Human-edited notes\n\n${Release.macSigningSection("ad-hoc")}`;
    assert.equal(Release.releaseNotes(root, "1.0.0", head, { draftBody: edited, macSigning: "ad-hoc" }), edited);
    assert.equal((first.match(/^- Merge feature /gm) ?? []).length, 40);
    assert.doesNotMatch(first, /internal setup|nightly/);
    assert.match(first, /`v0\.1\.9`/);
    assert.ok(first.includes(`https://github.com/koreyGambill/weavewing/compare/${base}...${head}`));
    git("tag", "--no-sign", "weavewing-v1.0.0", head);
    const next = git("commit-tree", tree, "-p", head, "-m", "fix: preserve history");
    assert.match(Release.releaseNotes(root, "1.0.1", next), /Changes since weavewing-v1\.0\.0:\n\n- fix: preserve history/);
    assert.equal(Release.releaseNotes(root, "1.0.1", next, { draftBody: edited, macSigning: "developer-id" }), `Human-edited notes\n\n${Release.macSigningSection("developer-id")}`);
    const notes = Path.join(root, "notes.md");
    FS.writeFileSync(notes, "Explicit replacement");
    assert.equal(Release.releaseNotes(root, "1.0.1", next, { draftBody: "Keep", notesFile: notes }), `Explicit replacement\n\n${Release.macSigningSection(undefined)}\n`);
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

test("Mac job startup removes only runs whose build process has exited and reports runs without a marker", () => {
  const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-mac-cleanup-"));
  try {
    const base = Path.join(home, "weavewing-release");
    const run = (name: string, marker?: string) => {
      FS.mkdirSync(Path.join(base, name), { recursive: true });
      FS.writeFileSync(Path.join(base, name, "AuthKey.p8"), "old signing material");
      if (marker !== undefined) FS.writeFileSync(Path.join(base, name, "build.pid"), marker);
      const old = new Date(Date.UTC(2026, 0, 1));
      FS.utimesSync(Path.join(base, name), old, old);
    };
    run("run-killed", String(CP.spawnSync("true").pid));
    run("run-building", String(process.pid));
    run("run-unmarked");
    run("run-empty-marker", "");
    run("run-bad-marker", "12; rm -rf /");
    FS.mkdirSync(Path.join(base, "keep"));
    const result = CP.spawnSync("/bin/sh", ["-c", Release.macStartup("run-current")], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(FS.existsSync(Path.join(base, "run-killed")), false);
    for (const name of ["run-building", "run-unmarked", "run-empty-marker", "run-bad-marker"])
      assert.equal(FS.existsSync(Path.join(base, name, "AuthKey.p8")), true, `${name} may still hold credentials`);
    for (const name of ["run-unmarked", "run-empty-marker", "run-bad-marker"])
      assert.match(result.stderr, new RegExp(`${Path.join(base, name)} has no build PID marker; remove it by hand`));
    assert.doesNotMatch(result.stderr, /run-building/);
    assert.equal(FS.existsSync(Path.join(base, "run-current/source")), true);
    assert.equal(FS.existsSync(Path.join(base, "keep")), true);
    run("run-killed-under-lock", String(CP.spawnSync("true").pid));
    FS.mkdirSync(Path.join(base, "signing.lock"));
    const locked = CP.spawnSync("/bin/sh", ["-c", Release.macStartup("run-next")], { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    assert.equal(locked.status, 0);
    assert.equal(FS.existsSync(Path.join(base, "run-killed-under-lock/AuthKey.p8")), true, "a signer may outlive its build marker while the lock is held");
    assert.match(locked.stderr, /signing\.lock is held; leaving earlier runs in place/);
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
    writeEvidence("stable", "passed");
    assert.throws(() => Release.verifyPromotionAssets(downloaded, ["app.zip"], local, "weavewing-v1.0.0", "abc123", "stable", { appleSigningConfigured: true }), /not a proven Developer ID build/);
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

test("stable promotion with Apple signing configured needs a Developer ID receipt for the uploaded Mac bytes", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-promote-mac-"));
  try {
    const receipts = Path.join(root, "receipts");
    const names = Release.macSignedAssets("1.0.0");
    const draft = (name: string, bytes: string, signed: boolean, channel = "stable") => {
      const evidence = macBuild(root, name, bytes, signed, "1.0.0");
      Release.recordMacSigning(Path.join(evidence, "mac-proof.json"), Path.join(evidence, "assets"), "1.0.0", receipts);
      FS.writeFileSync(Path.join(evidence, "assets/SHA256SUMS"), Release.assetInventory(Path.join(evidence, "assets"), names).map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""));
      FS.writeFileSync(Path.join(evidence, "release.json"), JSON.stringify({ repository: "koreyGambill/weavewing", tag: "weavewing-v1.0.0", target: "abc123", channel, ci: "passed", draft: true }));
      return evidence;
    };
    const promote = (evidence: string, options: { appleSigningConfigured?: boolean }, channel: "stable" | "test" = "stable") =>
      Release.verifyPromotionAssets(Path.join(evidence, "assets"), names, evidence, "weavewing-v1.0.0", "abc123", channel, { ...options, receipts });
    const adHoc = draft("ad-hoc", "ad-hoc", false);
    assert.throws(() => promote(adHoc, { appleSigningConfigured: true }), /not a proven Developer ID build/);
    assert.equal(promote(adHoc, {}), "ad-hoc");
    assert.equal(promote(draft("ad-hoc-test", "ad-hoc test", false, "test"), { appleSigningConfigured: true }, "test"), "ad-hoc");
    assert.equal(promote(draft("signed", "signed", true), { appleSigningConfigured: true }), "developer-id");
    const unrecorded = draft("unrecorded", "unrecorded", true);
    FS.rmSync(receipts, { recursive: true });
    assert.throws(() => promote(unrecorded, {}), /No Mac build receipt/);
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

function macBuild(root: string, name: string, bytes: string, signed: boolean, version = "0.1.0") {
  const dir = Path.join(root, name);
  FS.mkdirSync(Path.join(dir, "assets"), { recursive: true });
  for (const asset of Release.macSignedAssets(version)) FS.writeFileSync(Path.join(dir, "assets", asset), `${bytes} ${asset}`);
  const proof = { signed, ...(signed ? { developerId: { failures: [] } } : {}), assets: Release.macAssetDigests(Path.join(dir, "assets"), Release.macSignedAssets(version)) };
  FS.writeFileSync(Path.join(dir, "mac-proof.json"), JSON.stringify(proof));
  return dir;
}

test("a draft's macOS signing comes from a receipt for its exact Mac asset bytes, wherever those assets were built", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-mac-receipts-"));
  try {
    const receipts = Path.join(root, "receipts");
    const names = Release.expectedAssets("0.1.0", ["linux", "mac"]);
    const signed = macBuild(root, "signed-run", "signed", true);
    assert.equal(Release.recordMacSigning(Path.join(signed, "mac-proof.json"), Path.join(signed, "assets"), "0.1.0", receipts), "developer-id");
    for (const name of FS.readdirSync(receipts)) assert.equal(FS.statSync(Path.join(receipts, name)).mode & 0o777, 0o600);
    // A Linux-only rerun carries the signed Mac assets forward from the draft.
    assert.equal(Release.draftMacSigning(Path.join(signed, "assets"), names, receipts), "developer-id");
    // Reused evidence whose Mac assets were replaced with an ad-hoc build keeps the old proof but not its result.
    const adHoc = macBuild(root, "ad-hoc-run", "ad-hoc", false);
    FS.copyFileSync(Path.join(signed, "mac-proof.json"), Path.join(adHoc, "mac-proof.json"));
    assert.throws(() => Release.draftMacSigning(Path.join(adHoc, "assets"), names, receipts), /No Mac build receipt/);
    assert.throws(() => Release.recordMacSigning(Path.join(adHoc, "mac-proof.json"), Path.join(adHoc, "assets"), "0.1.0", receipts), /does not cover/);
    const proven = macBuild(root, "ad-hoc-proven", "ad-hoc", false);
    assert.equal(Release.recordMacSigning(Path.join(proven, "mac-proof.json"), Path.join(proven, "assets"), "0.1.0", receipts), "ad-hoc");
    assert.equal(Release.draftMacSigning(Path.join(adHoc, "assets"), names, receipts), "ad-hoc");
    assert.equal(Release.draftMacSigning(Path.join(adHoc, "assets"), Release.expectedAssets("0.1.0", ["linux"]), receipts), undefined);
    const unproven = macBuild(root, "unproven", "unproven", true);
    FS.writeFileSync(Path.join(unproven, "mac-proof.json"), JSON.stringify({ signed: true, developerId: { failures: ["no ticket"] }, assets: Release.macAssetDigests(Path.join(unproven, "assets"), names) }));
    assert.throws(() => Release.recordMacSigning(Path.join(unproven, "mac-proof.json"), Path.join(unproven, "assets"), "0.1.0", receipts), /unproven Developer ID/);
    FS.rmSync(Path.join(unproven, "mac-proof.json"));
    assert.throws(() => Release.recordMacSigning(Path.join(unproven, "mac-proof.json"), Path.join(unproven, "assets"), "0.1.0", receipts), /ENOENT/);
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});

test("the Mac build host comes from configuration and must be a plain SSH destination", () => {
  assert.throws(() => Release.macHost(undefined), /WEAVEWING_MAC_HOST --variable/);
  assert.throws(() => Release.macHost(""), /WEAVEWING_MAC_HOST --variable/);
  for (const value of ["-oProxyCommand=sh", "host name", "host;rm", "@mac-builder", "builder@", "a@b@c", "builder@-oProxyCommand=sh"]) assert.throws(() => Release.macHost(value), /SSH host/);
  assert.equal(Release.macHost("builder@mac-builder.local"), "builder@mac-builder.local");
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
