import assert from "node:assert/strict";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { appendReport, markdownCell } from "./confirm.ts";

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
