import assert from "node:assert/strict";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { failingTestFiles, parseTaskList } from "./suites.ts";

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
