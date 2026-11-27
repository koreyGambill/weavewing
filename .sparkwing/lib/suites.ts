import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Context } from "@sparkwing/sdk";

import { type Checkout, git, isCommittedCheckout, logged } from "./checkout.ts";

/**
 * The workspace's own tasks, from the `  [package#]task: command` lines `vp run` prints without a
 * terminal. A line in any other shape fails, so a changed format cannot silently drop packages.
 */
export function parseTaskList(list: string, task: string): string[] {
  const lines = list.split("\n").filter((line) => line.trim());
  const ids = lines.map((line) => /^ {2}(\S+): /.exec(line)?.[1]);
  const unread = lines.find((_, index) => ids[index] === undefined);
  if (lines.length === 0 || unread !== undefined)
    throw new Error(`vp run printed a task list this pipeline cannot read: ${JSON.stringify(unread ?? "")}`);
  return ids
    .map((id) => id!.split("#"))
    .filter(([name, found]) => found === task && name !== "@t3tools/monorepo")
    .map(([name]) => name!);
}

/** Packages that define `task` as Vite+ itself resolves them: manifest scripts and vite.config tasks. */
export function packagesWithTask(co: Checkout, task: string): string[] {
  const list = NodeChildProcess.execFileSync("vp", ["run"], {
    cwd: co.root,
    env: { ...process.env, ...co.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseTaskList(list, task);
}

/** The package test suite: every package with a test task except the server and web, which run alone. */
export function packageTestNames(co: Checkout): string[] {
  return packagesWithTask(co, "test").filter((name) => name !== "t3" && name !== "@t3tools/web");
}

/**
 * Runs `vp run --filter <name> <script...>` for each package, four at a time, then fails naming
 * every package that failed. One recursive vp run would stop every remaining package after the
 * first failure. An empty selection, or a name vp does not know, fails instead of passing.
 */
export async function eachPackage(
  ctx: Context,
  co: Checkout,
  label: string,
  names: readonly string[],
  script: readonly string[],
): Promise<void> {
  if (names.length === 0) throw new Error(`${label}: no packages selected`);
  const queue = [...names];
  const failed: string[] = [];
  const worker = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const log = `${label}-${name.replace(/[^\w.-]+/g, "-")}`;
      await logged(ctx, co, log, ["vp", "run", "--fail-if-no-match", "--filter", name, ...script]).catch(() => failed.push(name));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (failed.length > 0) throw new Error(`${label} failed in: ${failed.sort().join(", ")}`);
}

interface Suite {
  /** Admission cores: web and server run vitest with Chromium or four workers, packages four at a time. */
  readonly cores: number;
  readonly run: (ctx: Context, co: Checkout) => Promise<void>;
}

/** The full suites ci runs, each reporting every failing file or package in one pass. */
export const SUITES = {
  // One vitest run over the unit and browser projects.
  web: {
    cores: 6,
    run: async (ctx, co) => {
      await logged(ctx, co, "test-web", ["vp", "run", "--filter", "@t3tools/web", "test"]);
    },
  },
  // One vitest run; test:cached runs a vp task per file, and vp run stops the rest after a failure.
  server: {
    cores: 6,
    run: async (ctx, co) => {
      await logged(ctx, co, "test-server", ["vp", "run", "--filter", "t3", "test", "--maxWorkers=4"]);
    },
  },
  packages: { cores: 4, run: (ctx, co) => eachPackage(ctx, co, "packages", packageTestNames(co), ["test"]) },
} satisfies Record<string, Suite>;

export type SuiteName = keyof typeof SUITES;

/** Runs web, server and packages one after another, then fails naming every suite that failed. */
/** passed or failed once vitest reported its test files; not-run when it never got that far. */
export type SuiteResult = "passed" | "failed" | "not-run";

// Vitest prints this summary only after it has collected and run test files.
const TEST_FILES_SUMMARY = /^\s*Test Files\s+\d/m;

/** Whether a suite's logs in dir show that vitest ran test files: every one of its logs has the summary. */
export function suiteRan(dir: string, suite: SuiteName): boolean {
  const names = NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : [];
  const logs = suite === "packages" ? names.filter((name) => /^packages-.+\.log$/.test(name)) : [`test-${suite}.log`];
  return (
    logs.length > 0 &&
    logs.every((log) => {
      const path = NodePath.join(dir, log);
      return NodeFS.existsSync(path) && TEST_FILES_SUMMARY.test(NodeFS.readFileSync(path, "utf8"));
    })
  );
}

export async function everySuite(ctx: Context, co: Checkout): Promise<Record<SuiteName, SuiteResult>> {
  const results = {} as Record<SuiteName, SuiteResult>;
  for (const [name, suite] of Object.entries(SUITES) as Array<[SuiteName, Suite]>) {
    const passed = await suite.run(ctx, co).then(
      () => true,
      (error: unknown) => {
        ctx.log.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      },
    );
    results[name] = !suiteRan(co.evidence, name) ? "not-run" : passed ? "passed" : "failed";
  }
  return results;
}

/** Evidence that every suite ran to a result against one committed tree. */
export interface SuiteReceipt {
  readonly commit: string;
  readonly tree: string;
  readonly results: Record<SuiteName, "passed" | "failed">;
  readonly finishedAt: string;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Where `suite --full` keeps its receipts on this machine. */
export function receiptsDir(): string {
  const home = NodeOS.homedir();
  if (!NodePath.isAbsolute(home)) throw new Error(`The home directory must be absolute, got "${home}"`);
  return NodePath.join(home, "evidence/t3code/sparkwing/full-suites");
}

/** The full commit and tree ids of a checkout with no uncommitted or untracked files, else undefined. */
export function testedTree(root: string): { commit: string; tree: string } | undefined {
  if (git(root, "status", "--porcelain", "--untracked-files=all")) return undefined;
  return { commit: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
}

export function writeReceipt(dir: string, receipt: SuiteReceipt): void {
  if (!OBJECT_ID.test(receipt.tree) || !OBJECT_ID.test(receipt.commit)) throw new Error("Receipts need full object ids");
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, `${receipt.tree}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(receipt, null, 2));
  NodeFS.renameSync(temporary, file);
}

/**
 * Writes the receipt for a `suite --full` run and returns whether it did. Like Sparkwing's own rule
 * that only a host-made checkout of the sealed commit proves that commit passed, only a run in a
 * Sparkwing branch checkout counts: a clean developer checkout can still hold ignored files that
 * change a build. Every suite must have reached its tests and the tree must not have moved. The
 * host runs as the same user as any agent, so this guards against accidents, not forgery.
 */
export function recordReceipt(
  dir: string,
  root: string,
  results: Record<SuiteName, SuiteResult>,
  before: { commit: string; tree: string } | undefined,
  after: { commit: string; tree: string } | undefined,
): boolean {
  const ran = Object.values(results).every((result) => result !== "not-run");
  const unchanged = before !== undefined && after?.commit === before.commit && after.tree === before.tree;
  if (!ran || !unchanged || !isCommittedCheckout(root)) return false;
  writeReceipt(dir, { ...before, results: results as SuiteReceipt["results"], finishedAt: new Date().toISOString() });
  return true;
}

/** The receipt whose full commit or tree id equals the one given, compared exactly. */
export function receiptFor(dir: string, match: { commit?: string; tree?: string }): SuiteReceipt | undefined {
  if (!NodeFS.existsSync(dir)) return undefined;
  for (const name of NodeFS.readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
    let receipt: SuiteReceipt;
    try {
      receipt = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const complete =
      OBJECT_ID.test(receipt.commit) &&
      OBJECT_ID.test(receipt.tree) &&
      name === `${receipt.tree}.json` &&
      Object.keys(SUITES).every((suite) => ["passed", "failed"].includes(receipt.results?.[suite as SuiteName]));
    if (complete && (receipt.commit === match.commit || receipt.tree === match.tree)) return receipt;
  }
  return undefined;
}

export function isSuiteName(name: string): name is SuiteName {
  return Object.hasOwn(SUITES, name);
}

/** Each test file vitest reports as failed in a directory of suite logs, by log name. */
export function failingTestFiles(dir: string): Array<{ readonly log: string; readonly file: string }> {
  if (!NodeFS.existsSync(dir)) return [];
  const found = new Map<string, { log: string; file: string }>();
  for (const name of NodeFS.readdirSync(dir).filter((entry) => entry.endsWith(".log")).sort()) {
    const log = name.replace(/\.log$/, "");
    for (const [, file] of NodeFS.readFileSync(NodePath.join(dir, name), "utf8").matchAll(/^ FAIL {2}(?:\|[^|]+\| )?(\S+)/gm))
      found.set(`${log}\0${file}`, { log, file: file! });
  }
  return [...found.values()];
}
