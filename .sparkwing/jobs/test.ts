import { definePipeline } from "@sparkwing/sdk";

import { checkout, checkoutArgs, logged } from "../lib/checkout.ts";

definePipeline({
  name: "Test",
  short: "Run the changed-files gate, or focused tests with --files",
  help: "Without --files, runs the gate pipeline so both commands reuse the same recorded passes.",
  args: [
    ...checkoutArgs,
    {
      name: "files",
      type: "[]string",
      description: "Comma-separated test files or directories, relative to the worktree",
    },
    { name: "ref", type: "string", description: "Compare against the merge base with this ref (gate only)" },
  ],
  plan(p, run) {
    if (run.args.files === undefined) {
      p.job("gate", async (ctx) => {
        const { worktree, evidence, ref } = ctx.args;
        const result = await ctx.runPipeline<{ log: string }>("gate", "check-changed", {
          args: { worktree: worktree ?? "", ...(evidence ? { evidence } : {}), ...(ref ? { ref } : {}) },
        });
        ctx.log.info("Changed-files gate passed", result);
        return result;
      })
        .inline()
        .cores(0.25)
        .startsChildren("gate");
      return;
    }

    p.job("test", async (ctx) => {
      const co = checkout(ctx);
      const files = (ctx.args.files ?? "").split(",").map((file) => file.trim()).filter(Boolean);
      if (files.length === 0) throw new Error("--files names no test files");
      await logged(ctx, co, "test", ["vp", "test", "run", "--maxWorkers=2", ...files]);
    })
      .inline()
      .cores(2);
  },
});
