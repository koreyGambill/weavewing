import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Context } from "@sparkwing/sdk";

import { type Checkout, logged } from "./checkout.ts";

/** The workspace's own tasks, from the `package#task: command` list `vp run` prints without a terminal. */
export function parseTaskList(list: string, task: string): string[] {
  return [...list.matchAll(/^ {2}([^\s#:]+)#([^\s:]+): /gm)]
    .filter(([, name, found]) => found === task && name !== "@t3tools/monorepo")
    .map(([, name]) => name!);
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
export async function everySuite(ctx: Context, co: Checkout): Promise<void> {
  const failed: string[] = [];
  for (const [name, suite] of Object.entries(SUITES)) {
    await suite.run(ctx, co).catch((error: unknown) => {
      ctx.log.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      failed.push(name);
    });
  }
  if (failed.length > 0) throw new Error(`Suites failed: ${failed.join(", ")}`);
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Removes `clone-*` directories directly inside root that are more than a day old; returns them. */
export function removeStaleClones(root: string, now = Date.now()): string[] {
  if (!NodeFS.existsSync(root)) return [];
  const stale = NodeFS.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("clone-"))
    .map((entry) => NodePath.join(root, entry.name))
    .filter((dir) => now - NodeFS.lstatSync(dir).mtimeMs > DAY_MS);
  for (const dir of stale) NodeFS.rmSync(dir, { recursive: true, force: true });
  return stale;
}
