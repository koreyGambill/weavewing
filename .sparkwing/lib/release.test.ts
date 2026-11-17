import assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { assertCleanBundle, buildEnvironment, expectedAssets, releaseInputs, renderReleaseNotes, verifyChecksums } from "./release.ts";

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

test("release inputs reject non-stable versions and unknown or duplicate platforms", () => {
  for (const version of ["v1.0.0", "1.0.0-beta", "01.0.0", "1.0", "1.0.0+build"])
    assert.throws(() => releaseInputs(version, "linux"));
  for (const platforms of ["", "linux,linux", "linux,android", "linux,"])
    assert.throws(() => releaseInputs("1.0.0", platforms));
  assert.equal(releaseInputs("1.0.0", "mac,win").tag, "weavewing-v1.0.0");
  assert.equal(expectedAssets("1.0.0", ["linux", "win", "mac"]).length, 14);
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

test("bundle boundary rejects baked public config and requires the fork feed", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "weavewing-bundle-"));
  try {
    for (const dir of ["apps/server/dist", "apps/web/dist", "apps/desktop/dist-electron"]) {
      FS.mkdirSync(Path.join(root, dir), { recursive: true });
      FS.writeFileSync(Path.join(root, dir, "main.js"), 'const repository="koreyGambill/weavewing";');
    }
    assertCleanBundle(root);
    for (const value of ["pk_live_abc123", "https://relay.t3.codes", "https://api.axiom.co/v1/traces", "__T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__", 'tracesUrl:readBuildTimeValue("https://telemetry.example/traces")', 'tracesToken:h(`arbitrary-token`)', "analyticsEnabled: true"]) {
      FS.writeFileSync(Path.join(root, "apps/server/dist/main.js"), value);
      assert.throws(() => assertCleanBundle(root));
    }
    const env = buildEnvironment("/usr/bin", "/home/build", "/tmp/build");
    assert.equal(env.T3CODE_DESKTOP_UPDATE_REPOSITORY, "koreyGambill/weavewing");
    assert.equal(env.T3CODE_CLERK_PUBLISHABLE_KEY, undefined);
    assert.equal(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN, undefined);
    assert.equal(env.GITHUB_REPOSITORY, undefined);
  } finally {
    FS.rmSync(root, { recursive: true });
  }
});
