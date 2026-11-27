import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Context, definePipeline, type Job } from "@sparkwing/sdk";

import {
  type Changes,
  changedFiles,
  checkout,
  checkoutArgs,
  comparisonBase,
  decideChanges,
  git,
  logged,
} from "../lib/checkout.ts";
import { eachPackage, packagesWithTask, packageTestNames, SUITES } from "../lib/suites.ts";

// Mirrors .github/workflows/ci.yml. Not ported: Rust tests, the xvfb desktop launch smoke and
// mobile_native_static_analysis (macOS). .sparkwing/workflows.json tracks them.
// Change-dependent jobs use skipIf, which runs only after the job's cores are admitted; generating
// them from the changes output failed with plan_drift on replay (run-81dbc6536cf86825653d8b03).
const BUDGET = "apps/server/src/provider/agentContextBudget.json";
const NODE_SCRIPT_TESTS = [
  ".github/scripts/check-nightly-release.test.cjs",
  ".github/scripts/vercel-deployment-output.test.cjs",
  ".github/scripts/mobile-preview-comment.test.cjs",
  ".github/scripts/test-delta.test.cjs",
  // thread-transfer-report.yml's self-test; that workflow's PR comment stays on GitHub.
  ".github/scripts/thread-transfer-report.test.cjs",
];

interface ChangesOutput extends Changes {
  readonly base: string;
}

definePipeline({
  name: "Ci",
  short: "The jobs of ci.yml that run on this host, admitted by cores",
  help:
    "Repo-wide: for the lead's batch and upstream-merge gates, not per-change checks. Jobs a change cannot " +
    "affect skip, as in CI; --full runs all of them.",
  args: [
    ...checkoutArgs,
    { name: "ref", type: "string", description: "Compare against the merge base with this ref" },
    { name: "full", type: "bool", description: "Run every job regardless of what changed" },
    {
      name: "allow-context-increase",
      type: "bool",
      description: "Accept agent context growth (the agent-context-increase label)",
    },
  ],
  plan(p) {
    const changes = p
      .job<ChangesOutput>("changes", (ctx) => {
        const co = checkout(ctx);
        const base = comparisonBase(co.root, ctx.args.ref || undefined);
        const full = ctx.args.full === "true";
        const decided = decideChanges(co.root, full ? null : changedFiles(co.root, base), full);
        ctx.log.info(`affected: ${decided.affected.join(", ") || "none"}`, { ...decided.outputs, base });
        return { ...decided, base };
      })
      .inline()
      .cores(0.25);
    const decided = async (ctx: Context) => {
      const out = await ctx.output(changes);
      if (!out) throw new Error("changes output is unavailable");
      return out;
    };
    const unless =
      (key: keyof Changes["outputs"]) =>
      async (ctx: Context): Promise<boolean> =>
        !(await decided(ctx)).outputs[key];
    const run = (ctx: Context, name: string, argv: readonly [string, ...string[]]) =>
      logged(ctx, checkout(ctx), name, argv);

    const electron = p
      .job("electron", (ctx) => run(ctx, "electron", ["vp", "run", "--filter", "@t3tools/desktop", "ensure:electron"]))
      .inline()
      .cores(1);

    const lint = p.job("lint").inline().cores(4).needs(electron).failurePolicy("collect_all");
    lint.step("pr-assets", (ctx) => {
      const files = git(checkout(ctx).root, "ls-files", ".github/pr-assets");
      if (files) throw new Error(`Upload PR evidence to GitHub instead of committing it:\n${files}`);
    });
    lint.step("knip", (ctx) => run(ctx, "knip", ["vp", "run", "knip:check"]));
    lint.step("graphql-github", (ctx) =>
      run(ctx, "graphql-github", ["vp", "run", "--filter", "@t3tools/source-control-github", "generate", "--check"]),
    );
    lint.step("graphql-server", (ctx) =>
      run(ctx, "graphql-server", ["vp", "run", "--filter", "t3", "generate", "--check"]),
    );
    lint.step("check", (ctx) => run(ctx, "check", ["vp", "check"]));

    p.job("typecheck", (ctx) => {
      const co = checkout(ctx);
      return eachPackage(ctx, co, "typecheck", packagesWithTask(co, "typecheck"), ["--cache", "typecheck"]);
    })
      .inline()
      .cores(4)
      .needs(changes, electron)
      .skipIf(unless("typecheck"));

    p.job("context-budget", async (ctx) => {
      const co = checkout(ctx);
      const { base } = await decided(ctx);
      let before: Record<string, number>;
      try {
        before = JSON.parse(git(co.root, "show", `${base}:${BUDGET}`));
      } catch {
        ctx.log.info("The base has no agent context budget yet.");
        return;
      }
      const after: Record<string, number> = JSON.parse(NodeFS.readFileSync(NodePath.join(co.root, BUDGET), "utf8"));
      const grown = Object.entries(after)
        .filter(([key, value]) => before[key] !== undefined && value > before[key]!)
        .map(([key, value]) => `${key}: ${before[key]} -> ${value} (+${value - before[key]!})`);
      if (grown.length === 0) return;
      const report = `Agent context grew compared to ${base}:\n${grown.join("\n")}`;
      if (ctx.args["allow-context-increase"] === "true") {
        ctx.log.warn(`${report}\nAccepted by --allow-context-increase.`);
        return;
      }
      throw new Error(
        `${report}\nCut the added text and rerun the evals that cover it (evals/README.md), or pass --allow-context-increase.`,
      );
    })
      .inline()
      .cores(0.25)
      .needs(changes);

    const test = p
      .job("test")
      .inline()
      .cores(4)
      .needs(changes, electron)
      .failurePolicy("collect_all")
      .skipIf(unless("test"));
    test.step("preview-bundle", (ctx) =>
      run(ctx, "preview-bundle", ["python3", "-B", ".github/scripts/stage-preview-bundle.test.py"]),
    );
    test.step("release-checks", (ctx) => run(ctx, "release-checks", ["node", "--test", ...NODE_SCRIPT_TESTS]));
    test.step("packages", async (ctx) => {
      const chosen = (await decided(ctx)).outputs.test_packages.split(" ").filter(Boolean);
      const co = checkout(ctx);
      await eachPackage(ctx, co, "packages", chosen.length > 0 ? chosen : packageTestNames(co), ["test"]);
    });

    p.job("test-web", (ctx) => SUITES.web.run(ctx, checkout(ctx)))
      .inline()
      .cores(SUITES.web.cores)
      .needs(changes)
      .skipIf(unless("test_web"));

    p.job("test-server", (ctx) => SUITES.server.run(ctx, checkout(ctx)))
      .inline()
      .cores(SUITES.server.cores)
      .needs(changes)
      .skipIf(unless("test_server"));

    const build: Job = p.job("build").inline().cores(6).needs(changes, electron).skipIf(unless("build"));
    const desktop = build.step("desktop", (ctx) => run(ctx, "build-desktop", ["vp", "run", "build:desktop"]));
    build
      .step("preload-bundle", (ctx) =>
        run(ctx, "preload-bundle", ["node", "apps/desktop/scripts/verify-preload-bundle.mjs"]),
      )
      .needs(desktop);
    build
      .step("web-boot", (ctx) => run(ctx, "web-boot", ["node", "apps/web/scripts/verify-built-boot.ts"]))
      .needs(desktop)
      .skipIf(unless("test_web"));

    p.job("workflow-map", (ctx) => {
      const co = checkout(ctx);
      const map: { workflows: Record<string, unknown> } = JSON.parse(
        NodeFS.readFileSync(NodePath.join(co.root, ".sparkwing/workflows.json"), "utf8"),
      );
      const files = NodeFS.readdirSync(NodePath.join(co.root, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f));
      const unmapped = files.filter((file) => !(file in map.workflows));
      const gone = Object.keys(map.workflows).filter((file) => !files.includes(file));
      if (unmapped.length + gone.length > 0)
        throw new Error(
          `.sparkwing/workflows.json is out of date. Unmapped: ${unmapped.join(", ") || "none"}. ` +
            `Removed upstream: ${gone.join(", ") || "none"}.`,
        );
    })
      .inline()
      .cores(0.25);

    p.job("release-smoke", (ctx) => run(ctx, "release-smoke", ["node", "scripts/release-smoke.ts"]))
      .inline()
      .cores(2)
      .needs(changes)
      .skipIf(unless("release_smoke"));
  },
});
