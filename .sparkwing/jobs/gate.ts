import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { definePipeline, memoKey, noMemo } from "@sparkwing/sdk";

import {
  changedFiles,
  type Checkout,
  type CheckChangedInputs,
  checkChangedInputs,
  checkout,
  checkoutArgs,
  comparisonBase,
  definitionDigest,
  logged,
  toolchainVersions,
} from "../lib/checkout.ts";

// Two gates fit beside the daemon's machine reserve on 16 cores. check-changed weighs typecheck
// by its worker count, so a budget below 6 queued typecheck behind knip (+25 s measured).
const GATE_CORES = 6;

interface LockPackage {
  readonly version?: string;
  readonly integrity?: string;
  readonly optional?: boolean;
}

/** npm's hidden lockfile records what is installed; optional platform packages may be absent. */
function pipelineDepsMatchLockfile(root: string): boolean {
  const read = (file: string): Record<string, LockPackage> | undefined => {
    try {
      return JSON.parse(NodeFS.readFileSync(NodePath.join(root, ".sparkwing", file), "utf8")).packages;
    } catch {
      return undefined;
    }
  };
  const wanted = read("package-lock.json");
  const installed = read("node_modules/.package-lock.json");
  if (!wanted || !installed) return false;
  return Object.entries(wanted).every(([path, want]) => {
    if (path === "") return true;
    const have = installed[path];
    if (!have) return want.optional === true;
    return have.version === want.version && have.integrity === want.integrity;
  });
}
const CHECK_CHANGED_CONCURRENCY = String(GATE_CORES);

/** The environment check:changed runs with, which the key covers. */
const checksEnv = (co: Checkout) => ({ ...process.env, ...co.env, CHECK_CHANGED_CONCURRENCY });

definePipeline({
  name: "Gate",
  short: "vp run check:changed, admitted by cores instead of the checks lock",
  help:
    "The exit code is the verdict. Resubmitting identical content against the same base, from any checkout run " +
    "with the same -C, returns the recorded pass without a new log; a tree edited during the run fails instead of passing. " +
    "The key does not read installed package files or files under ignored build, cache and state directories " +
    "(dist, dist-*, target, .t3, .alchemy, .turbo, .cache, *.tsbuildinfo): after editing inside node_modules run " +
    "vp i, and run a check that reads the others with --no-memo.",
  args: [
    ...checkoutArgs,
    { name: "ref", type: "string", description: "Compare against the merge base with this ref" },
  ],
  plan(p) {
    p.job("pipelines", async (ctx) => {
      const co = checkout(ctx);
      // Sparkwing installs .sparkwing/ for the checkout it runs from, and other jobs' SDK processes load
      // from it, so reinstall only a tree that does not match its lockfile (another --worktree).
      if (!pipelineDepsMatchLockfile(co.root))
        await logged(ctx, co, "pipelines-install", [
          "npm", "ci", "--prefix", ".sparkwing", "--ignore-scripts", "--no-audit", "--no-fund",
        ]);
      await logged(ctx, co, "pipelines-typecheck", ["npm", "--prefix", ".sparkwing", "run", "typecheck"]);
      await logged(ctx, co, "pipelines-test", ["node", "--test", ".sparkwing/lib/checkout.test.ts"]);
    })
      .inline()
      .cores(0.25)
      .skipIf((ctx) => {
        const co = checkout(ctx);
        const base = comparisonBase(co.root, ctx.args.ref || undefined);
        return !changedFiles(co.root, base).some((file) => file.startsWith(".sparkwing/"));
      });

    // The memo key is taken before check:changed reads the tree for minutes, so a pass only counts
    // when the sources are unchanged afterwards; otherwise an edit made mid-run would be memoized.
    // The checks regenerate ignored outputs themselves, so those changing is not an edit. The pass
    // stays recorded under the pre-run key: resubmitting that same state reruns the same checks.
    const keyFile = (evidence: string) => NodePath.join(evidence, ".check-changed-inputs.json");
    p.job("check-changed", async (ctx) => {
      const co = checkout(ctx);
      const ref = ctx.args.ref;
      const base = comparisonBase(co.root, ref || undefined);
      const before: CheckChangedInputs = NodeFS.existsSync(keyFile(co.evidence))
        ? JSON.parse(NodeFS.readFileSync(keyFile(co.evidence), "utf8"))
        : checkChangedInputs(co.root, base, checksEnv(co));
      const log = await logged(ctx, co, "check-changed", ["vp", "run", "check:changed", ...(ref ? [ref] : [])], {
        CHECK_CHANGED_CONCURRENCY,
      });
      const after = checkChangedInputs(co.root, base, checksEnv(co));
      if (after.sources !== before.sources)
        throw new Error("The worktree changed during the gate, so this pass is not recorded; rerun the gate.");
      if (after.generated !== before.generated)
        ctx.log.info("check:changed regenerated ignored outputs (.astro, .generated, *.d.ts); sources unchanged.");
      return { log };
    })
      .inline()
      .cores(GATE_CORES)
      .memo((ctx) => {
        const co = checkout(ctx);
        const inputs = checkChangedInputs(co.root, comparisonBase(co.root, ctx.args.ref || undefined), checksEnv(co));
        if (!inputs.memoizable) return noMemo;
        NodeFS.writeFileSync(keyFile(co.evidence), JSON.stringify(inputs));
        return memoKey(
          "check-changed/v4",
          inputs.sources,
          inputs.generated,
          co.nodeVersion,
          toolchainVersions(co),
          definitionDigest(NodePath.join(import.meta.dirname, "..")),
          CHECK_CHANGED_CONCURRENCY,
        );
      });
  },
});
