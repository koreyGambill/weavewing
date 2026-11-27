import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { definePipeline, workDir } from "@sparkwing/sdk";

import { evidenceDir, git } from "../lib/checkout.ts";
import { appendReport, markdownCell } from "../lib/confirm.ts";
import { failingTestFiles, receiptFor, receiptsDir } from "../lib/suites.ts";

const BRANCH = "main";

/** Appends a dated section naming the failing test files in the suite logs. */
function recordFailures(file: string, head: string, runId: string, logs: string) {
  const rows = failingTestFiles(logs).map(({ log, file: path }) => `| ${markdownCell(log)} | ${markdownCell(path)} |`);
  const body =
    rows.length > 0
      ? `| Log | File |\n| --- | --- |\n${rows.join("\n")}\n`
      : `No failing test file appears in the suite logs; read them in \`${logs}\`.\n`;
  appendReport(
    file,
    `\n## ${new Date().toISOString()}: daily confirmation of origin/${BRANCH} ${head.slice(0, 10)}\n\n` +
      `Run \`${runId}\` failed. Logs: \`${logs}\`.\n\n${body}`,
  );
}

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
          { branch: `origin/${BRANCH}`, args: { full: "true", evidence: logs } },
        );
        ctx.log.info(`origin/${BRANCH} ${tested.commit.slice(0, 10)} passed every suite`, tested.results);
      } catch (error) {
        // main may have moved between the fetch and the child's checkout, so name what it tested.
        let commit = head;
        try {
          commit = JSON.parse(NodeFS.readFileSync(NodePath.join(logs, "tested.json"), "utf8")).commit || head;
        } catch {
          // The child failed before it recorded a commit.
        }
        recordFailures(file, commit, ctx.run.id, logs);
        throw error;
      }
    })
      .inline()
      .cores(0.25)
      .startsChildren("suite");
  },
});
