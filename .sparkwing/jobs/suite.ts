import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ConcurrencyGroup, type Context, definePipeline, workDir } from "@sparkwing/sdk";

import { type Checkout, checkoutArgs, checkoutAt, evidencePath, git } from "../lib/checkout.ts";
import {
  everySuite,
  isSuiteName,
  receiptsDir,
  recordReceipt,
  SUITES,
  type SuiteName,
  claimEvidence,
  suiteRoot,
  testedTree,
} from "../lib/suites.ts";

const FULL_SUITE_CORES = Math.max(...Object.values(SUITES).map((suite) => suite.cores));
const machineSuite = new ConcurrencyGroup("machine-suite", { capacity: 1, scope: "box" });

async function suiteCheckout(ctx: Context): Promise<Checkout> {
  const root = suiteRoot(ctx.args, workDir());
  if (ctx.args.install !== "true") return checkoutAt(ctx, root);
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
    `cores (${Object.entries(SUITES).map(([name, suite]) => `${name} ${suite.cores}`).join(", ")}) for the whole run. ` +
    "Use --worktree to test an existing checkout or --install in a Sparkwing branch checkout. " +
    `--full holds ${FULL_SUITE_CORES} cores and runs all three one after another as batch work, which is the full result main-health ` +
    "reads. Only a run in a checkout Sparkwing made for a branch, as confirm-main starts, records a receipt " +
    "that confirms main; a run on --worktree reports but confirms nothing.",
  args: [
    ...checkoutArgs.map((arg) =>
      arg.name === "worktree"
        ? { ...arg, required: false, description: "Absolute path of an installed checkout to test" }
        : arg,
    ),
    { name: "suite", type: "string", description: "web, server or packages" },
    { name: "full", type: "bool", description: "Run web, server and packages one after another" },
    { name: "install", type: "bool", description: "Install and test this Sparkwing branch checkout (confirm-main's child)" },
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
      // Classification reads only this run's logs, so the run claims a directory of its own.
      claimEvidence(evidencePath(ctx));
      const co = await suiteCheckout(ctx);
      const commit = git(co.root, "rev-parse", "HEAD");
      const tree = git(co.root, "rev-parse", "HEAD^{tree}");
      // A parent that started this run reads the commit it tested even when the run fails.
      NodeFS.writeFileSync(NodePath.join(co.evidence, "tested.json"), JSON.stringify({ commit, tree }));
      if (!full) {
        await suite!.run(ctx, co);
        return { commit, tree, results: { [name]: "passed" } };
      }
      const before = testedTree(co.root);
      const results = await everySuite(ctx, co);
      // Written only once every suite reached a result, so a stopped run reports nothing about main.
      NodeFS.writeFileSync(NodePath.join(co.evidence, "results.json"), JSON.stringify({ commit, tree, results }));
      const after = testedTree(co.root);
      if (!recordReceipt(receiptsDir(), co.root, results, before, after))
        ctx.log.warn(
          "No receipt: this run reports but confirms nothing, because it was not in a Sparkwing branch checkout, " +
            "a suite did not reach its tests, or the tree changed.",
        );
      const failed = (Object.entries(results) as Array<[SuiteName, string]>)
        .filter(([, result]) => result !== "passed")
        .map(([each, result]) => `${each} (${result})`);
      if (failed.length > 0) throw new Error(`Suites failed: ${failed.join(", ")}`);
      return { commit, tree, results };
    })
      .inline()
      .cores(full ? FULL_SUITE_CORES : (suite?.cores ?? 0.25))
      .concurrency(machineSuite);
  },
});
