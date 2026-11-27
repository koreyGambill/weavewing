import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Context, definePipeline } from "@sparkwing/sdk";

import { checkout, checkoutArgs, logged } from "../lib/checkout.ts";

const COMPAT_TEST = "apps/server/src/upstreamClientCompat.test.ts";

definePipeline({
  name: "UpstreamContracts",
  short: "Check the fork's wire payloads against upstream's contracts",
  help:
    "Runs the pinned compatibility sweep and probes representative mobile wire payloads at --ref with upstream's Effect. " +
    "--write refreshes and tests the pinned snapshot with a ref that uses the fork's Effect version.",
  args: [
    ...checkoutArgs,
    { name: "ref", type: "string", default: "upstream/main", description: "Upstream ref to bundle contracts from" },
    { name: "write", type: "bool", description: "Refresh apps/server/src/upstreamClientCompat.snapshot.js in the worktree" },
  ],
  plan(p) {
    const job = p.job("upstream-contracts").inline().cores(2);
    const fetch = job
      .step("fetch", async (ctx) => {
        await logged(ctx, checkout(ctx), "fetch", ["git", "fetch", "--no-tags", "upstream"]);
      })
      .skipIf((ctx) => !(ctx.args.ref ?? "upstream/main").startsWith("upstream/"));
    const snapshotEnv = (ctx: Context, root: string): Record<string, string> =>
      ctx.args.write === "true"
        ? {}
        : {
            UPSTREAM_SNAPSHOT: NodePath.join(
              root,
              "apps/server/node_modules/.cache",
              `upstream-contracts-${ctx.run.id}.mjs`,
            ),
          };
    const refresh = job
      .step("refresh", async (ctx) => {
        const co = checkout(ctx);
        await logged(
          ctx,
          co,
          "refresh",
          ["node", "scripts/refresh-upstream-contracts.ts", ctx.args.ref || "upstream/main"],
          snapshotEnv(ctx, co.root),
        );
      })
      .needs(fetch);
    job
      .step("compat-test", async (ctx) => {
        const co = checkout(ctx);
        const env = snapshotEnv(ctx, co.root);
        try {
          await logged(ctx, co, "compat-test", ["vp", "test", "run", "--maxWorkers=2", COMPAT_TEST], env);
        } finally {
          if (env.UPSTREAM_SNAPSHOT && NodeFS.existsSync(env.UPSTREAM_SNAPSHOT)) {
            NodeFS.rmSync(env.UPSTREAM_SNAPSHOT);
          }
        }
      })
      .needs(refresh);
  },
});
