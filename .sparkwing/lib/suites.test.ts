import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTaskList } from "./suites.ts";

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
