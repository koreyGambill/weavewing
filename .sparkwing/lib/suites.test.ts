import assert from "node:assert/strict";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { failingTestFiles, parseTaskList, removeStaleClones } from "./suites.ts";

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
  assert.deepEqual(parseTaskList("error: no tasks\n", "typecheck"), []);
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

test("only clone directories in the cache folder older than a day are removed", () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "confirm-clones-"));
  try {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const name of ["clone-old", "clone-new", "keep-old"]) FS.mkdirSync(Path.join(root, name));
    FS.writeFileSync(Path.join(root, "clone-file"), "not a directory\n");
    for (const name of ["clone-old", "keep-old", "clone-file"]) FS.utimesSync(Path.join(root, name), old, old);
    assert.deepEqual(removeStaleClones(root), [Path.join(root, "clone-old")]);
    assert.deepEqual(FS.readdirSync(root).sort(), ["clone-file", "clone-new", "keep-old"]);
    assert.deepEqual(removeStaleClones(Path.join(root, "missing")), []);
  } finally {
    FS.rmSync(root, { recursive: true, force: true });
  }
});
