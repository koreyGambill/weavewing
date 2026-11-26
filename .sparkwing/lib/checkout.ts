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

/** NUL-separated paths from git, so no name is quoted or split by a newline. */
function gitPaths(root: string, ...args: string[]): string[] {
  return NodeChildProcess.execFileSync("git", ["-C", root, ...args, "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

/** Changed and untracked paths against base, as check:changed and CI see them. */
export function changedFiles(root: string, base: string): string[] {
  return [
    ...new Set([
      ...gitPaths(root, "diff", "--name-only", "--no-renames", base, "--"),
      ...gitPaths(root, "ls-files", "--others", "--exclude-standard"),
    ]),
  ].sort();
}

export interface CheckChangedInputs {
  /** Sources, selection, environment and install state: anything an edit during a gate can change. */
  readonly sources: string;
  /** Ignored files, which the checks may regenerate themselves (astro check, mobile generators). */
  readonly generated: string;
  /** False when a tracked symlink leads outside the checkout, whose target the key cannot see. */
  readonly memoizable: boolean;
}

// Ignored dependencies, build outputs, caches and dev state that checks do not read as sources.
// Installed packages count through the lockfile and install metadata instead.
const IGNORED_SKIP = /(^|\/)(node_modules|dist|dist-[^/]+|target|\.t3|\.alchemy|\.turbo|\.cache)(\/|$)|\.tsbuildinfo$/;
// Variables that the checks, their configs or the tests read to decide behaviour.
const CHECK_ENV = /^(CI|CHECK_CHANGED_\w+|NODE_\w+|VITE_\w+|VITEST_\w+|T3CODE_\w+|T3_\w+|EFFECT_\w+|PLAYWRIGHT_\w+|VERCEL_\w+|GITHUB_REPOSITORY|APP_VERSION|PORT|HOST)$/;

/**
 * The content check:changed reads, never where it sits, so checkouts of one tree share a pass:
 * - base: the commit check:changed compares against, which fixes every unchanged tracked file;
 * - the selection: the changed and untracked paths check:changed itself will check;
 * - the binary diff against base and the bytes of changed and untracked files, including files
 *   only a local exclude rule hides, since typecheck and tests read them;
 * - ignored files outside IGNORED_SKIP, and .env files, which checks read;
 * - install state, without pnpm's prune timestamp, which differs per install of one lockfile.
 *   Installed package files themselves are not hashed: an edit inside node_modules that keeps
 *   the lockfile and install metadata goes unseen, and `vp i` or `--no-memo` is the remedy;
 * - the CHECK_ENV variables of `env`, and the host platform.
 * Every path and content is a length-prefixed record, so no two input sets hash alike.
 */
export function checkChangedInputs(
  root: string,
  base: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CheckChangedInputs {
  const sources = NodeCrypto.createHash("sha256");
  const generated = NodeCrypto.createHash("sha256");
  const record = (hash: NodeCrypto.Hash, value: string | Buffer) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  };
  const add = (hash: NodeCrypto.Hash, file: string) => {
    record(hash, file);
    const path = NodePath.join(root, file);
    const link = NodeFS.lstatSync(path, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) record(hash, `link:${NodeFS.readlinkSync(path)}`);
    if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) return record(hash, link ? "other" : "missing");
    const bytes = NodeFS.readFileSync(path);
    record(hash, file === MODULES_YAML ? bytes.toString("utf8").replace(/^\s*"prunedAt":.*$/m, "") : bytes);
  };

  for (const part of [base, process.platform, process.arch]) record(sources, part);
  for (const [name, value] of Object.entries(env).filter(([name]) => CHECK_ENV.test(name)).sort())
    record(sources, `${name}=${value}`);
  const selected = changedFiles(root, base);
  record(sources, `selected:${selected.length}`);
  for (const file of selected) record(sources, file);
  record(
    sources,
    NodeChildProcess.execFileSync(
      "git",
      ["-C", root, "diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"],
      { maxBuffer: 1024 * 1024 * 1024 },
    ),
  );
  const untracked = gitPaths(root, "ls-files", "--others", "--exclude-per-directory=.gitignore");
  const files = [...new Set([...selected, ...untracked])].sort();
  record(sources, `files:${files.length}`);
  for (const file of files) add(sources, file);
  for (const file of [MODULES_YAML, "node_modules/.pnpm/lock.yaml"]) add(sources, file);

  const ignored = gitPaths(root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory")
    .filter((entry) => !IGNORED_SKIP.test(entry))
    .flatMap((entry) =>
      entry.endsWith("/")
        ? NodeFS.readdirSync(NodePath.join(root, entry), { recursive: true, withFileTypes: true })
            .filter((dirent) => !dirent.isDirectory())
            .map((dirent) => NodePath.relative(root, NodePath.join(dirent.parentPath, dirent.name)))
        : [entry],
    )
    .filter((file) => !IGNORED_SKIP.test(file))
    .sort();
  for (const file of ignored) add(/(^|\/)\.env[^/]*$/.test(file) ? sources : generated, file);

  const realRoot = NodeFS.realpathSync(root);
  const memoizable = NodeChildProcess.execFileSync("git", ["-C", root, "ls-files", "-s", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.startsWith("120000 "))
    .every((entry) => {
      const link = NodePath.join(realRoot, entry.slice(entry.indexOf("\t") + 1));
      if (!NodeFS.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
      let target = NodePath.resolve(NodePath.dirname(link), NodeFS.readlinkSync(link));
      try {
        target = NodeFS.realpathSync(link);
      } catch {
        // A dangling link is judged by where it points.
      }
      return target === realRoot || target.startsWith(realRoot + NodePath.sep);
    });
  return { sources: sources.digest("hex"), generated: generated.digest("hex"), memoizable };
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

/**
 * Workspace packages that define a typecheck script or name typecheck in their vite.config tasks.
 * A config that names it without defining the task fails `vp run` loudly, never silently.
 */
export function typecheckPackageNames(root: string): string[] {
  const named = /\btypecheck\b/;
  return ciChanges(root)
    .readWorkspace()
    .filter((pkg) => {
      const dir = NodePath.join(root, pkg.dir);
      const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "package.json"), "utf8"));
      if (typeof manifest.scripts?.typecheck === "string") return true;
      return NodeFS.readdirSync(dir)
        .filter((file) => /^vite\.config\.[cm]?[jt]s$/.test(file))
        .some((file) => named.test(NodeFS.readFileSync(NodePath.join(dir, file), "utf8")));
    })
    .map((pkg) => pkg.name);
}

export const CODE = /\.(?:[cm]?[jt]sx?|astro)$/;
