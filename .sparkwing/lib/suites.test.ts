import assert from "node:assert/strict";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import * as CP from "node:child_process";

import { failingTestFiles, parseTaskList, receiptFor, testedTree, writeReceipt } from "./suites.ts";

const list = `  typecheck: vp run -r --cache --concurrency-limit 4 typecheck
  @t3tools/contracts#typecheck: effect-tsgo tsrs --noEmit
  @t3tools/contracts#test: vp test run
  @t3tools/web#typecheck: effect-tsgo tsrs --noEmit
  @t3tools/monorepo#typecheck: vp run -r --cache --concurrency-limit 4 typecheck
  t3#typecheck:watch: effect-tsgo tsrs --noEmit --watch
`;

test("the task list names each package that defines the task, without the workspace root", () => {
  assert.deepEqual(parseTaskList(list, "typecheck"), ["@t3tools/contracts", "@t3tools/web"]);
  assert.deepEqual(parseTaskList(list, "test"), ["@t3tools/contracts"]);
  assert.deepEqual(parseTaskList("  t3#typecheck:watch: tsgo --watch\n  t3#typecheck: tsgo\n", "typecheck"), ["t3"]);
});

test("a task list with any line it cannot read fails instead of dropping packages", () => {
  assert.throws(() => parseTaskList(`${list}   @t3tools/web#test: vp test run\n`, "test"), /cannot read/);
  assert.throws(() => parseTaskList("error: no tasks\n", "typecheck"), /cannot read/);
  assert.throws(() => parseTaskList("\n", "typecheck"), /cannot read/);
});

test("failing test files are read from every suite log, once each", () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "suite-logs-"));
  try {
    FS.writeFileSync(
      Path.join(dir, "packages--t3tools-mobile.log"),
      " FAIL  |react| src/a.test.tsx > case one\n FAIL  |react| src/a.test.tsx > case two\n ✓ src/b.test.ts\n",
    );
    FS.writeFileSync(Path.join(dir, "test-server.log"), " FAIL  src/c.test.ts > case\n");
    FS.writeFileSync(Path.join(dir, "notes.txt"), " FAIL  ignored.test.ts\n");
    assert.deepEqual(failingTestFiles(dir), [
      { log: "packages--t3tools-mobile", file: "src/a.test.tsx" },
      { log: "test-server", file: "src/c.test.ts" },
    ]);
    assert.deepEqual(failingTestFiles(Path.join(dir, "missing")), []);
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

const tree = "a".repeat(40);
const commit = "b".repeat(40);
const results = { web: "passed", server: "failed", packages: "passed" } as const;

test("a receipt matches only the full commit or tree id it records, with every suite's result", () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "suite-receipts-"));
  try {
    assert.equal(receiptFor(dir, { tree }), undefined);
    writeReceipt(dir, { commit, tree, results, finishedAt: "2026-11-27T02:00:00.000Z" });
    assert.equal(receiptFor(dir, { tree })?.commit, commit);
    assert.equal(receiptFor(dir, { commit })?.tree, tree);
    assert.equal(receiptFor(dir, { tree: tree.slice(0, 12) }), undefined);
    assert.equal(receiptFor(dir, { commit: "c".repeat(40) }), undefined);
    const other = "d".repeat(40);
    FS.writeFileSync(Path.join(dir, `${other}.json`), JSON.stringify({ commit, tree: other, results: { web: "passed" } }));
    assert.equal(receiptFor(dir, { tree: other }), undefined, "a receipt missing a suite");
    FS.writeFileSync(Path.join(dir, `${"e".repeat(40)}.json`), JSON.stringify({ commit, tree: other, results }));
    assert.equal(receiptFor(dir, { tree: other }), undefined, "a receipt filed under another tree");
    assert.throws(() => writeReceipt(dir, { commit: "abc", tree, results, finishedAt: "" }), /full object ids/);
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

test("only a clean checkout has a tested tree", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "tested-tree-"));
  const git = (...args: string[]) =>
    CP.execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "--initial-branch=main");
    FS.writeFileSync(Path.join(root, ".gitignore"), "node_modules/\n");
    FS.writeFileSync(Path.join(root, "a.ts"), "1\n");
    git("add", ".");
    git("commit", "-m", "first");
    FS.mkdirSync(Path.join(root, "node_modules"));
    assert.deepEqual(testedTree(root), { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") });
    FS.writeFileSync(Path.join(root, "b.ts"), "2\n");
    assert.equal(testedTree(root), undefined, "an untracked file");
    FS.rmSync(Path.join(root, "b.ts"));
    FS.writeFileSync(Path.join(root, "a.ts"), "3\n");
    assert.equal(testedTree(root), undefined, "an edited file");
  } finally {
    FS.rmSync(root, { recursive: true, force: true });
  }
});
