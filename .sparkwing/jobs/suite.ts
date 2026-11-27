import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type Context, definePipeline, workDir } from "@sparkwing/sdk";

import { type Checkout, checkoutArgs, checkoutAt } from "../lib/checkout.ts";
import { everySuite, isSuiteName, receiptsDir, SUITES, testedTree, writeReceipt } from "../lib/suites.ts";

/**
 * --worktree when given; otherwise this run's own checkout, such as the committed checkout of a
 * child run on a branch, installed first because it starts with no dependencies.
 */
async function suiteCheckout(ctx: Context): Promise<Checkout> {
  if (ctx.args.worktree) return checkoutAt(ctx, ctx.args.worktree);
  const root = workDir();
  const path = [NodePath.join(NodeOS.homedir(), ".vite-plus/bin"), process.env.PATH ?? ""].join(":");
  // A plain install: `xwing app install` would link the main checkout's env files into it.
  await ctx.exec(["vp", "i"], { cwd: root, env: { PATH: path } }).run();
  const co = checkoutAt(ctx, root);
  await ctx
    .exec(["node", "apps/web/node_modules/playwright/cli.js", "install", "--only-shell", "chromium"], {
      cwd: root,
      env: co.env,
    })
    .run()
    .catch((error: unknown) => {
      throw new Error("Installing Playwright's Chromium for the web suite failed", { cause: error });
    });
  return co;
}

definePipeline({
  name: "Suite",
  short: "One full test suite (web, server or packages), or all three, admitted by its cores",
  help:
    "Runs the named suite as ci does and reports every failing file or package. Admission holds the suite's " +
    "cores (web 6, server 6, packages 4) for the whole run. Without --worktree it installs and tests its own " +
    "checkout. --full runs all three one after another as batch work, which is the full result main-health " +
    "reads, and records a receipt of each suite's result when the tested tree was committed and clean.",
  args: [
    ...checkoutArgs.map((arg) =>
      arg.name === "worktree"
        ? { ...arg, required: false, description: "Absolute path of the checkout to test (default: this run's own)" }
        : arg,
    ),
    { name: "suite", type: "string", description: "web, server or packages" },
    { name: "full", type: "bool", description: "Run web, server and packages one after another" },
  ],
  plan(p, run) {
    // Discovery plans without arguments, so an invalid choice fails when the job runs.
    const full = run.args.full === "true";
    const name = run.args.suite ?? "";
    const suite = isSuiteName(name) ? SUITES[name] : undefined;
    // Every suite in a row is long and latency-insensitive, so it waits behind interactive work.
    // Some server tests read git history, which a branch checkout's default depth of one lacks.
    if (full) p.admissionClass("batch").checkout({ fullHistory: true });
    p.job("suite", async (ctx) => {
      if (full === Boolean(name)) throw new Error("Pass either --suite web|server|packages or --full");
      if (!full && !suite) throw new Error(`--suite must be web, server or packages, got "${name}"`);
      const co = await suiteCheckout(ctx);
      if (!full) return suite!.run(ctx, co);
      const before = testedTree(co.root);
      const results = await everySuite(ctx, co);
      const after = testedTree(co.root);
      // A receipt says these files were tested, so only a clean tree that stayed put earns one.
      if (before && after && before.commit === after.commit && before.tree === after.tree)
        writeReceipt(receiptsDir(), { ...before, results, finishedAt: new Date().toISOString() });
      else ctx.log.warn("No receipt: the worktree had uncommitted or untracked files, or changed during the run.");
      const failed = Object.entries(results).filter(([, result]) => result === "failed").map(([each]) => each);
      if (failed.length > 0) throw new Error(`Suites failed: ${failed.join(", ")}`);
    })
      .inline()
      .cores(full ? Math.max(...Object.values(SUITES).map((each) => each.cores)) : (suite?.cores ?? 0.25));
  },
});
