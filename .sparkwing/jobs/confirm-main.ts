import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { definePipeline, workDir } from "@sparkwing/sdk";

import { evidenceDir, git } from "../lib/checkout.ts";
import { reportFailure } from "../lib/confirm.ts";
import { receiptFor, receiptsDir } from "../lib/suites.ts";

const BRANCH = "main";

definePipeline({
  name: "ConfirmMain",
  short: "Run every suite on origin/main, unless a receipt already records its commit or tree",
  help:
    "Confirms main while the machine is otherwise idle and gates nothing. It fetches origin/main and stops when " +
    "a `suite --full` receipt already records every suite's result for that commit or tree. Otherwise it starts " +
    "`suite --full` as a child run on origin/main, which Sparkwing checks out fresh, and appends the failing files " +
    "to --known-failures when it fails.",
  args: [
    { name: "force", type: "bool", description: "Run even when the head already has a receipt" },
    {
      name: "known-failures",
      type: "string",
      description: "Absolute file that collects failing files (default ~/evidence/weavewing/main-green/known-main-failures.md)",
    },
    { name: "evidence", type: "string", description: "Absolute directory for logs" },
  ],
  plan(p, request) {
    p.admissionClass("batch");
    const force = request.args.force === "true";
    p.job("confirm", async (ctx) => {
      const file =
        ctx.args["known-failures"] ||
        NodePath.join(NodeOS.homedir(), "evidence/weavewing/main-green/known-main-failures.md");
      if (!NodePath.isAbsolute(file)) throw new Error(`--known-failures must be absolute, got "${file}"`);
      // The remote's own configuration and credential helper reach it; no URL passes through here.
      await ctx.exec(["git", "-C", workDir(), "fetch", "--quiet", "--no-tags", "origin", BRANCH]).run();
      const head = git(workDir(), "rev-parse", "--verify", `refs/remotes/origin/${BRANCH}^{commit}`);
      const tree = git(workDir(), "rev-parse", "--verify", `${head}^{tree}`);
      const covered = force ? undefined : receiptFor(receiptsDir(), { commit: head, tree });
      if (covered) return ctx.log.info(`${head.slice(0, 10)} has a receipt from ${covered.finishedAt}`);

      const logs = NodePath.join(evidenceDir(ctx), "suites");
      try {
        // An awaited child holds no runner slot, so only the child's own cores are admitted.
        const tested = await ctx.runPipeline<{ commit: string; tree: string; results: Record<string, string> }>(
          "suite",
          "suite",
          { branch: `origin/${BRANCH}`, args: { full: "true", install: "true", evidence: logs } },
        );
        ctx.log.info(`origin/${BRANCH} ${tested.commit.slice(0, 10)} passed every suite`, tested.results);
      } catch (error) {
        reportFailure(file, `origin/${BRANCH}`, ctx.run.id, logs);
        throw error;
      }
    })
      .inline()
      .cores(0.25)
      .startsChildren("suite");
  },
});
