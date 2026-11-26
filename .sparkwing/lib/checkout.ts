import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ArgSpec, Context } from "@sparkwing/sdk";

export const checkoutArgs: ArgSpec[] = [
  {
    name: "worktree",
    type: "string",
    required: true,
    description: "Absolute path of the checkout to run in",
  },
  {
    name: "evidence",
    type: "string",
    description:
      "Absolute directory for command logs (default ~/evidence/t3code/sparkwing/runs/<pipeline>/<run id>)",
  },
];

export interface Checkout {
  readonly root: string;
  readonly evidence: string;
  readonly nodeVersion: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Resolves --worktree and --evidence, and the Node runtime the checkout's engines.node pins. */
export function checkout(ctx: Context): Checkout {
  const root = ctx.args.worktree ?? "";
  if (!NodePath.isAbsolute(root)) throw new Error(`--worktree must be absolute, got "${root}"`);
  if (!NodeFS.existsSync(NodePath.join(root, ".git")))
    throw new Error(`--worktree ${root} is not the root of a git checkout`);
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
  const nodeVersion: unknown = manifest.engines?.node;
  if (typeof nodeVersion !== "string") throw new Error(`${root}/package.json has no engines.node`);
  const home = NodeOS.homedir();
  const nodeBin = NodePath.join(home, ".vite-plus/js_runtime/node", nodeVersion, "bin");
  if (!NodeFS.existsSync(NodePath.join(nodeBin, "node")))
    throw new Error(`Node ${nodeVersion} (engines.node) is missing at ${nodeBin}; run vp i first`);

  const evidence =
    ctx.args.evidence ||
    NodePath.join(home, "evidence/t3code/sparkwing/runs", ctx.run.pipeline, ctx.run.id);
  if (!NodePath.isAbsolute(evidence)) throw new Error(`--evidence must be absolute: ${evidence}`);
  NodeFS.mkdirSync(evidence, { recursive: true });

  return {
    root,
    evidence,
    nodeVersion,
    env: {
      PATH: [nodeBin, NodePath.join(home, ".vite-plus/bin"), process.env.PATH ?? ""].join(":"),
      PLAYWRIGHT_BROWSERS_PATH: NodePath.join(home, ".cache/ms-playwright"),
      VITEST_MAX_WORKERS: "2",
    },
  };
}

/** Runs argv under nice in the checkout, teeing combined output to <evidence>/<name>.log. */
export async function logged(
  ctx: Context,
  co: Checkout,
  name: string,
  argv: readonly [string, ...string[]],
  env: Readonly<Record<string, string>> = {},
): Promise<string> {
  const log = NodePath.join(co.evidence, `${name}.log`);
  ctx.log.info(`${name}: ${argv.join(" ")}`, { log });
  try {
    await ctx
      .exec(
        ["bash", "-c", 'set -o pipefail; nice -n 10 "$@" 2>&1 | tee "$SW_LOG"', "bash", ...argv],
        { cwd: co.root, env: { ...co.env, ...env, SW_LOG: log } },
      )
      .run();
  } catch (error) {
    throw new Error(`${name} failed; log: ${log}`, { cause: error });
  }
  return log;
}

export function git(root: string, ...args: string[]): string {
  // Unquoted paths, as check:changed reads them, so non-ASCII names hash and stat correctly.
  return NodeChildProcess.execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** check:changed's base: the merge base with ref, or the closest merge base with any remote's main. */
export function comparisonBase(root: string, ref?: string): string {
  const candidates = ref
    ? [ref]
    : git(root, "remote")
        .split("\n")
        .filter(Boolean)
        .map((remote) => `refs/remotes/${remote}/main`);
  let closest: { base: string; ahead: number } | undefined;
  for (const candidate of candidates) {
    let base: string;
    try {
      base = git(root, "merge-base", "HEAD", candidate);
    } catch {
      continue;
    }
    const ahead = Number(git(root, "rev-list", "--count", `${base}..HEAD`));
    if (!closest || ahead < closest.ahead) closest = { base, ahead };
  }
  if (!closest) throw new Error(`No merge base with ${candidates.join(", ") || "a remote main"}`);
  return closest.base;
}

/** Changed and untracked paths against base, as check:changed and CI see them. */
export function changedFiles(root: string, base: string): string[] {
  const lines = (...args: string[]) => git(root, ...args).split("\n").filter(Boolean);
  return [
    ...new Set([
      ...lines("diff", "--name-only", "--no-renames", base, "--"),
      ...lines("ls-files", "--others", "--exclude-standard"),
    ]),
  ].sort();
}

export interface CheckChangedInputs {
  /** Sources and install state: anything an edit during a gate can change. */
  readonly sources: string;
  /** Ignored outputs the checks regenerate themselves (astro check, mobile generators). */
  readonly generated: string;
}

/**
 * The content check:changed reads, never where it sits, so checkouts of one tree share a pass:
 * - base: the commit check:changed compares against, which fixes every unchanged tracked file;
 * - the binary diff against base and the raw bytes of changed files: edits, staged or not;
 * - untracked files, including ones only a local exclude rule hides, since typecheck and tests
 *   read them while the repository's own .gitignore files are tracked content;
 * - ignored generated files and .env files, which checks read;
 * - install state, without pnpm's prune timestamp, which differs per install of one lockfile;
 * - CI, which changes test behaviour, and the host platform.
 */
export function checkChangedInputs(root: string, base: string): CheckChangedInputs {
  const sources = NodeCrypto.createHash("sha256");
  const generated = NodeCrypto.createHash("sha256");
  sources.update(`${base}\0${process.env.CI ?? ""}\0${process.platform}\0${process.arch}\0`);
  sources.update(
    NodeChildProcess.execFileSync(
      "git",
      ["-C", root, "diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"],
      { maxBuffer: 1024 * 1024 * 1024 },
    ),
  );
  const ignored = git(
    root,
    "ls-files", "--others", "--ignored", "--exclude-standard", "--",
    ":(glob)**/.generated/**",
    ":(glob)**/.astro/**",
    ":(glob)**/*.d.ts",
    ":(glob)**/.env*",
    ":(exclude,glob)**/node_modules/**",
  )
    .split("\n")
    .filter(Boolean);
  const untracked = git(root, "ls-files", "--others", "--exclude-per-directory=.gitignore")
    .split("\n")
    .filter(Boolean);
  const add = (hash: NodeCrypto.Hash, file: string) => {
    hash.update(`\0${file}\0`);
    const path = NodePath.join(root, file);
    if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) return;
    const bytes = NodeFS.readFileSync(path);
    hash.update(file === MODULES_YAML ? bytes.toString("utf8").replace(/^\s*"prunedAt":.*$/m, "") : bytes);
  };
  const files = new Set([...changedFiles(root, base), ...untracked]);
  for (const file of [...files].sort()) add(sources, file);
  for (const file of [MODULES_YAML, "node_modules/.pnpm/lock.yaml"]) add(sources, file);
  for (const file of ignored) add(/(^|\/)\.env[^/]*$/.test(file) ? sources : generated, file);
  return { sources: sources.digest("hex"), generated: generated.digest("hex") };
}

const MODULES_YAML = "node_modules/.modules.yaml";

/** `vp --version` in the checkout: the global and local Vite+, its bundled tools, pnpm and Node. */
export function toolchainVersions(co: Checkout): string {
  return NodeChildProcess.execFileSync("vp", ["--version"], {
    cwd: co.root,
    env: { ...process.env, ...co.env },
    encoding: "utf8",
  }).trim();
}

/** Hash of a pipeline directory's own files, so a changed definition never reuses older passes. */
export function definitionDigest(dir: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const files = NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.relative(dir, NodePath.join(entry.parentPath, entry.name)))
    .filter((file) => !file.split(NodePath.sep).includes("node_modules"))
    .sort();
  for (const file of files) hash.update(`\0${file}\0`).update(NodeFS.readFileSync(NodePath.join(dir, file)));
  return hash.digest("hex");
}

interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly hasTest: boolean;
  readonly deps: readonly string[];
}

export interface Changes {
  readonly affected: string[];
  readonly outputs: {
    readonly typecheck: boolean;
    readonly build: boolean;
    readonly desktop_launch: boolean;
    readonly test: boolean;
    readonly test_packages: string;
    readonly test_web: boolean;
    readonly test_server: boolean;
    readonly rust: boolean;
    readonly release_smoke: boolean;
    readonly mobile_native: boolean;
  };
}

function ciChanges(root: string) {
  const require = NodeModule.createRequire(NodePath.join(root, "package.json"));
  return require("./.github/scripts/ci-changes.cjs") as {
    readWorkspace(): WorkspacePackage[];
    decide(files: readonly string[] | null, packages: WorkspacePackage[], full: boolean): Changes;
  };
}

/** CI's job decisions from the checkout's own .github/scripts/ci-changes.cjs. */
export function decideChanges(root: string, files: readonly string[] | null, full: boolean): Changes {
  const changes = ciChanges(root);
  return changes.decide(files, changes.readWorkspace(), full);
}

/** Packages with a test script that CI's package test job covers; server and web have their own jobs. */
export function packageTestNames(root: string): string[] {
  const own = new Set(["t3", "@t3tools/web", "@t3tools/monorepo"]);
  return ciChanges(root)
    .readWorkspace()
    .filter((pkg) => pkg.hasTest && !own.has(pkg.name))
    .map((pkg) => pkg.name);
}

export const CODE = /\.(?:[cm]?[jt]sx?|astro)$/;
