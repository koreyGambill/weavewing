import assert from "node:assert/strict";
import * as CP from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { test } from "node:test";

import { checkChangedInputs, comparisonBase, definitionDigest } from "./checkout.ts";

const git = (cwd: string, ...args: string[]) =>
  CP.execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", input: "" },
  ).trim();

const modulesYaml = (prunedAt: string) => `{\n  "layoutVersion": 5,\n  "prunedAt": "${prunedAt}",\n  "virtualStoreDir": ".pnpm"\n}\n`;

/** A source repository with main and a feature commit, cloned at the feature commit and installed. */
function fixture(dir: string) {
  const source = Path.join(dir, "source");
  FS.mkdirSync(source);
  git(source, "init", "--initial-branch=main");
  FS.writeFileSync(Path.join(source, ".gitignore"), "node_modules/\ndist/\n");
  FS.writeFileSync(Path.join(source, "a.test.ts"), "expect(1).toBe(1);\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "main");
  git(source, "switch", "-c", "feature");
  FS.writeFileSync(Path.join(source, "b.ts"), "export const b = 1;\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "feature");
  const clone = (name: string, prunedAt: string) => {
    const root = Path.join(dir, name);
    git(dir, "clone", "--quiet", "--branch", "feature", source, root);
    FS.mkdirSync(Path.join(root, "node_modules/.pnpm"), { recursive: true });
    FS.writeFileSync(Path.join(root, "node_modules/.modules.yaml"), modulesYaml(prunedAt));
    FS.writeFileSync(Path.join(root, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
    return root;
  };
  return { clone };
}

const inputs = (root: string) => checkChangedInputs(root, comparisonBase(root));

test("two checkouts of one tree, installed at different times, share the gate inputs", () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "checkout-inputs-"));
  try {
    const { clone } = fixture(dir);
    const first = clone("first", "Thu, 19 Nov 2026 05:33:23 GMT");
    const second = clone("elsewhere/second", "Thu, 26 Nov 2026 21:45:45 GMT");
    FS.mkdirSync(Path.join(second, "dist"));
    FS.writeFileSync(Path.join(second, "dist/out.js"), "built\n");
    assert.deepEqual(inputs(second), inputs(first));
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

test("any differing file a check can read changes the gate sources", () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "checkout-inputs-"));
  try {
    const { clone } = fixture(dir);
    const clean = inputs(clone("clean", "Thu, 19 Nov 2026 05:33:23 GMT")).sources;
    const root = clone("edited", "Thu, 19 Nov 2026 05:33:23 GMT");
    const write = (file: string, text: string) => {
      FS.mkdirSync(Path.dirname(Path.join(root, file)), { recursive: true });
      FS.writeFileSync(Path.join(root, file), text);
    };
    const edits: Array<[string, () => void, () => void]> = [
      ["one character in a tested file", () => write("a.test.ts", "expect(1).toBe(2);\n"), () => git(root, "checkout", "--", "a.test.ts")],
      [
        "a staged edit",
        () => {
          write("b.ts", "export const b = 2;\n");
          git(root, "add", "b.ts");
        },
        () => git(root, "checkout", "HEAD", "--", "b.ts"),
      ],
      ["an untracked file", () => write("c.ts", "export const c = 1;\n"), () => FS.rmSync(Path.join(root, "c.ts"))],
      [
        "a file only a local exclude rule hides",
        () => {
          write(".git/info/exclude", "local.ts\n");
          write("local.ts", "export const local = 1;\n");
        },
        () => FS.rmSync(Path.join(root, "local.ts")),
      ],
      ["an ignored .env file", () => write(".env.local", "KEY=1\n"), () => FS.rmSync(Path.join(root, ".env.local"))],
      [
        "a different install",
        () => write("node_modules/.pnpm/lock.yaml", "lockfileVersion: '9.1'\n"),
        () => write("node_modules/.pnpm/lock.yaml", "lockfileVersion: '9.0'\n"),
      ],
    ];
    assert.equal(inputs(root).sources, clean);
    for (const [name, edit, revert] of edits) {
      edit();
      assert.notEqual(inputs(root).sources, clean, name);
      revert();
      assert.equal(inputs(root).sources, clean, `${name}, reverted`);
    }
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed pipeline definition changes its digest, and its installed packages do not", () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "pipeline-definition-"));
  try {
    FS.mkdirSync(Path.join(dir, "jobs"));
    FS.mkdirSync(Path.join(dir, "node_modules/sdk"), { recursive: true });
    FS.writeFileSync(Path.join(dir, "jobs/gate.ts"), "const CORES = 6;\n");
    const before = definitionDigest(dir);
    FS.writeFileSync(Path.join(dir, "node_modules/sdk/index.js"), "installed\n");
    assert.equal(definitionDigest(dir), before);
    FS.writeFileSync(Path.join(dir, "jobs/gate.ts"), "const CORES = 4;\n");
    assert.notEqual(definitionDigest(dir), before);
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});
