import type { Context } from "@sparkwing/sdk";

import { type Checkout, logged, packageTestNames } from "./checkout.ts";

/**
 * Runs `vp run --filter <name> <script...>` for each package, four at a time, then fails naming
 * every package that failed. One recursive vp run would stop every remaining package after the
 * first failure.
 */
export async function eachPackage(
  ctx: Context,
  co: Checkout,
  label: string,
  names: readonly string[],
  script: readonly string[],
): Promise<void> {
  const queue = [...names];
  const failed: string[] = [];
  const worker = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const log = `${label}-${name.replace(/[^\w.-]+/g, "-")}`;
      await logged(ctx, co, log, ["vp", "run", "--filter", name, ...script]).catch(() => failed.push(name));
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
  packages: { cores: 4, run: (ctx, co) => eachPackage(ctx, co, "packages", packageTestNames(co.root), ["test"]) },
} satisfies Record<string, Suite>;

export type SuiteName = keyof typeof SUITES;

export function isSuiteName(name: string): name is SuiteName {
  return Object.hasOwn(SUITES, name);
}
