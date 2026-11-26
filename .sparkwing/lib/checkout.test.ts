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
  FS.writeFileSync(Path.join(source, ".gitignore"), "node_modules/\ndist/\nbuild/\n.env*\n");
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

const inputs = (root: string, env: Record<string, string> = {}) => checkChangedInputs(root, comparisonBase(root), env);

function withFixture(run: (clone: (name: string) => string) => void) {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "checkout-inputs-"));
  try {
    const { clone } = fixture(dir);
    run((name) => clone(name, "Thu, 19 Nov 2026 05:33:23 GMT"));
  } finally {
    FS.rmSync(dir, { recursive: true, force: true });
  }
}

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

test("a file one checkout's local exclude rule hides from check:changed keeps the keys apart", () =>
  withFixture((clone) => {
    const [hidden, selected] = [clone("hidden"), clone("selected")];
    for (const root of [hidden, selected]) FS.writeFileSync(Path.join(root, "broken.test.ts"), "expect(1).toBe(2);\n");
    FS.writeFileSync(Path.join(hidden, ".git/info/exclude"), "broken.test.ts\n");
    assert.notEqual(inputs(hidden).sources, inputs(selected).sources);
  }));

test("an edit to an untracked file whose name holds a newline changes the key", () =>
  withFixture((clone) => {
    const root = clone("framing");
    const write = (file: string, text: string) => FS.writeFileSync(Path.join(root, file), text);
    write("new\nline.ts", "1");
    const before = inputs(root).sources;
    write("new\nline.ts", "2");
    assert.notEqual(inputs(root).sources, before, "an edit to a file whose name holds a newline");
  }));

test("one file whose bytes spell a second file does not hash like the two files", () =>
  withFixture((clone) => {
    const root = clone("merging");
    const write = (file: string, text: string) => FS.writeFileSync(Path.join(root, file), text);
    write("p", "1\0q\0" + "2");
    const merged = inputs(root).sources;
    write("p", "1");
    write("q", "2");
    assert.notEqual(inputs(root).sources, merged);
  }));

test("the environment the checks read changes the key, and other variables do not", () =>
  withFixture((clone) => {
    const root = clone("environment");
    const base = inputs(root).sources;
    assert.notEqual(inputs(root, { CHECK_CHANGED_TIMEOUT: "0" }).sources, base);
    assert.notEqual(inputs(root, { CI: "true" }).sources, base);
    assert.equal(inputs(root, { TERM: "dumb" }).sources, base);
  }));

test("ignored files a check can import are inputs, and dependency and output folders are not", () =>
  withFixture((clone) => {
    const root = clone("ignored");
    FS.mkdirSync(Path.join(root, "build"));
    FS.writeFileSync(Path.join(root, "build/input.ts"), "export const input = 1;\n");
    const before = inputs(root);
    FS.writeFileSync(Path.join(root, "build/input.ts"), "export const input = 2;\n");
    assert.notDeepEqual(inputs(root), before);
    const edited = inputs(root);
    FS.mkdirSync(Path.join(root, "dist"));
    FS.writeFileSync(Path.join(root, "dist/out.js"), "built\n");
    FS.writeFileSync(Path.join(root, "node_modules/.pnpm/extra.js"), "installed\n");
    assert.deepEqual(inputs(root), edited);
  }));

test("a tracked symlink that leaves the checkout makes the gate refuse to memoize", () =>
  withFixture((clone) => {
    const root = clone("links");
    const outside = Path.join(Path.dirname(root), "outside.ts");
    FS.writeFileSync(outside, "export const outside = 1;\n");
    FS.symlinkSync("a.test.ts", Path.join(root, "inside.ts"));
    git(root, "add", "inside.ts");
    git(root, "commit", "-m", "inside link");
    assert.equal(inputs(root).memoizable, true);
    FS.symlinkSync(outside, Path.join(root, "outside.ts"));
    git(root, "add", "outside.ts");
    git(root, "commit", "-m", "outside link");
    assert.equal(inputs(root).memoizable, false);
  }));

test("the time zone and locale change the key, and cache locations do not", () =>
  withFixture((clone) => {
    const root = clone("locale");
    const utc = inputs(root, { TZ: "UTC" }).sources;
    assert.notEqual(inputs(root, { TZ: "America/Los_Angeles" }).sources, utc);
    assert.notEqual(inputs(root, { TZ: "UTC", LC_ALL: "de_DE.UTF-8" }).sources, utc);
    assert.equal(inputs(root, { TZ: "UTC", NODE_COMPILE_CACHE: "/elsewhere/cache" }).sources, utc);
  }));

test("a chain of tracked symlinks into an excluded directory makes the gate refuse to memoize", () =>
  withFixture((clone) => {
    const root = clone("chain");
    FS.mkdirSync(Path.join(root, ".cache"));
    FS.writeFileSync(Path.join(root, ".cache/input.ts"), "export const cached = 1;\n");
    FS.symlinkSync(".cache/input.ts", Path.join(root, "second.ts"));
    FS.symlinkSync("second.ts", Path.join(root, "first.ts"));
    git(root, "add", "first.ts", "second.ts");
    git(root, "commit", "-m", "links into the cache");
    assert.equal(inputs(root).memoizable, false);
  }));
