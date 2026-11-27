import assert from "node:assert/strict";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { appendReport, markdownCell, reportFailure } from "./confirm.ts";

test("the failure report is appended only at an absolute path that is not a symlink", () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "confirm-report-"));
  try {
    const file = Path.join(dir, "reports/known.md");
    appendReport(file, "one\n");
    appendReport(file, "two\n");
    assert.equal(FS.readFileSync(file, "utf8"), "one\ntwo\n");
    assert.throws(() => appendReport("relative.md", "x"), /must be absolute/);
    const target = Path.join(dir, "target.md");
    FS.writeFileSync(target, "kept\n");
    FS.symlinkSync(target, Path.join(dir, "link.md"));
    assert.throws(() => appendReport(Path.join(dir, "link.md"), "x"));
    assert.equal(FS.readFileSync(target, "utf8"), "kept\n");
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

test("table cells escape pipes, backticks and line breaks", () => {
  assert.equal(markdownCell("a|b`c\\d\ne"), "a\\|b\\`c\\\\d e");
});

test("a failed child adds a finding about main only when it reached testing", () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "confirm-failure-"));
  try {
    const file = Path.join(dir, "known.md");
    const logs = Path.join(dir, "suites");
    FS.mkdirSync(logs);
    assert.equal(reportFailure(file, "origin/main", "run-1", logs), false, "a child that could not plan");
    assert.equal(FS.existsSync(file), false);
    FS.writeFileSync(Path.join(logs, "tested.json"), JSON.stringify({ commit: "c".repeat(40), tree: "d".repeat(40) }));
    FS.writeFileSync(Path.join(logs, "test-server.log"), " FAIL  src/a.test.ts > case\n");
    assert.equal(reportFailure(file, "origin/main", "run-2", logs), true);
    const text = FS.readFileSync(file, "utf8");
    assert.match(text, /daily confirmation of origin\/main cccccccccc/);
    assert.match(text, /\| test-server \| src\/a\.test\.ts \|/);
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});
