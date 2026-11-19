import assert from "node:assert/strict";
import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { verifiedCi } from "./release-ci.ts";

test("full CI reuse requires the exact clean tree and runtime, and force invalidates a failed pass", async () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "release-ci-"));
  const root = Path.join(dir, "repo");
  FS.mkdirSync(root);
  const git = (...args: string[]) => CP.execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input: "" }).trim();
  try {
    git("init", "--initial-branch=main");
    const tree = git("mktree");
    const first = git("commit-tree", tree, "-m", "first");
    git("update-ref", "refs/heads/main", first);
    const co = { root, evidence: Path.join(dir, "evidence"), nodeVersion: "26.13.1", env: {} };
    const records = Path.join(dir, "passes");
    const options = { records, engine: "test-engine" };
    let calls = 0;
    const run = async () => { calls++; };
    const pass = await verifiedCi(co, "plan-run", run, options);
    assert.equal(calls, 1);
    git("update-ref", "refs/heads/main", git("commit-tree", tree, "-p", first, "-m", "same tree"));
    assert.deepEqual(await verifiedCi(co, "draft-run", run, options), pass);
    assert.equal(calls, 1);
    await verifiedCi(co, "force-run", run, { ...options, force: true });
    assert.equal(calls, 2);
    await assert.rejects(verifiedCi(co, "failed-run", async () => { throw new Error("CI failed"); }, { ...options, force: true }), /CI failed/);
    await verifiedCi(co, "retry-run", run, options);
    assert.equal(calls, 3);
    await verifiedCi(co, "node-run", run, { ...options, engine: "new-engine" });
    await verifiedCi({ ...co, nodeVersion: "26.14.0" }, "node-run", run, options);
    assert.equal(calls, 5);
    for (const file of FS.readdirSync(records)) FS.writeFileSync(Path.join(records, file), "invalid");
    await verifiedCi(co, "corrupt-run", run, options);
    assert.equal(calls, 6);
    FS.writeFileSync(Path.join(root, "source"), "changed");
    await assert.rejects(verifiedCi(co, "dirty-run", run, options), /clean/);
    assert.equal(calls, 6);
    git("add", "source");
    const changed = git("write-tree");
    git("update-ref", "refs/heads/main", git("commit-tree", changed, "-p", "HEAD", "-m", "changed"));
    await verifiedCi(co, "changed-run", run, options);
    assert.equal(calls, 7);
    await assert.rejects(verifiedCi(co, "moving-run", async () => {
      FS.writeFileSync(Path.join(root, "source"), "edit during CI");
    }, { ...options, force: true }), /clean|changed/);
    git("checkout", "--", "source");
    await verifiedCi(co, "after-move-run", run, options);
    assert.equal(calls, 8);
  } finally {
    FS.rmSync(dir, { recursive: true });
  }
});
