import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type Context, definePipeline, workDir } from "@sparkwing/sdk";

import { checkoutAt, evidenceDir } from "../lib/checkout.ts";
import { failingTestFiles } from "../lib/suites.ts";

const BRANCH = "main";

interface Prepared {
  readonly head: string;
  readonly clone?: string;
  readonly skip?: string;
}

const output = (argv: readonly [string, ...string[]]) =>
  NodeChildProcess.execFileSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Finished `suite --full` runs on this machine, as main-health counts them: commit and status. */
function fullResults(): Array<{ id: string; sha: string; status: string }> {
  return output(["sparkwing", "runs", "list", "--pipeline", "suite", "--since", "30d", "--limit", "1000", "-o", "json"])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => typeof row.sha === "string" && ["success", "failed"].includes(row.status));
}

const isFull = (id: string) =>
  JSON.parse(output(["sparkwing", "runs", "status", "--run", id, "--exit-zero", "-o", "json"])).inputs?.args?.full ===
  "true";

/** The run that already gives this tree a full result, if one does. */
function resultFor(clone: string | undefined, head: string): string | undefined {
  const tree = (sha: string) => {
    try {
      return output(["git", "-C", clone!, "rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
    } catch {
      return undefined;
    }
  };
  const headTree = clone ? tree(head) : undefined;
  return fullResults().find((row) => (row.sha === head || (headTree && tree(row.sha) === headTree)) && isFull(row.id))
    ?.id;
}

/** Appends a dated section naming the failing test files in the suite logs. */
function recordFailures(file: string, head: string, runId: string, logs: string) {
  const rows = failingTestFiles(logs).map(({ log, file: path }) => `| ${log} | ${path} |`);
  const body =
    rows.length > 0
      ? `| Log | File |\n| --- | --- |\n${rows.join("\n")}\n`
      : `No failing test file appears in the suite logs; read them in \`${logs}\`.\n`;
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.appendFileSync(
    file,
    `\n## ${new Date().toISOString()}: daily confirmation of origin/${BRANCH} ${head.slice(0, 10)}\n\n` +
      `Run \`${runId}\` failed. Logs: \`${logs}\`.\n\n${body}`,
  );
}

definePipeline({
  name: "ConfirmMain",
  short: "Run every suite on origin/main in a fresh clone, unless its tree already has a full result",
  help:
    "Confirms main while the machine is otherwise idle and gates nothing. It waits as batch work for the cores " +
    "a suite needs, then reads origin/main's head; when a finished `suite --full` run already covers that tree it " +
    "stops. Otherwise it clones origin/main into a new directory under --clones, installs it with `vp i` and Playwright's " +
    "Chromium, runs `sparkwing run suite --full` there, appends the failing files to --known-failures when it " +
    "fails, and removes the clone.",
  args: [
    { name: "force", type: "bool", description: "Run even when the head's tree already has a full result" },
    { name: "priority", type: "string", default: "0", description: "Admission priority of this run and its suites" },
    {
      name: "known-failures",
      type: "string",
      description: "File that collects failing files (default ~/evidence/weavewing/main-green/known-main-failures.md)",
    },
    {
      name: "clones",
      type: "string",
      description: "Directory for the temporary clone (default $XDG_CACHE_HOME or ~/.cache, then weavewing-confirm-main)",
    },
    { name: "evidence", type: "string", description: "Absolute directory for logs" },
  ],
  plan(p, request) {
    const priority = Number(request.args.priority ?? "0");
    p.admissionClass("batch").priority(Number.isFinite(priority) ? priority : 0);
    const force = request.args.force === "true";

    // Holding a suite's cores before cloning keeps a clone from waiting in the queue for hours,
    // and reads the head only once the machine has room for the run.
    const prepare = p
      .job<Prepared>("prepare", async (ctx) => {
        const url = output(["git", "-C", workDir(), "remote", "get-url", "origin"]);
        const remote = output(["git", "ls-remote", url, `refs/heads/${BRANCH}`]).split(/\s/)[0] ?? "";
        if (!remote) throw new Error(`origin has no ${BRANCH} branch`);
        const covered = force ? undefined : resultFor(undefined, remote);
        if (covered) return { head: remote, skip: `${remote.slice(0, 10)} already has full result ${covered}` };

        // Sparkwing removes a job's own temporary directory when the job ends, and the clone must
        // outlive this job for the next one.
        const root =
          ctx.args.clones ||
          NodePath.join(process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache"), "weavewing-confirm-main");
        NodeFS.mkdirSync(root, { recursive: true });
        const clone = NodeFS.mkdtempSync(NodePath.join(root, "clone-"));
        try {
          await ctx
            .exec([
              "git", "clone", "--quiet", "--single-branch", "--branch", BRANCH, "--no-tags",
              "--reference-if-able", workDir(), "--dissociate", url, clone,
            ])
            .run();
          const head = output(["git", "-C", clone, "rev-parse", "HEAD"]);
          const same = force ? undefined : resultFor(clone, head);
          if (same) {
            NodeFS.rmSync(clone, { recursive: true, force: true });
            return { head, skip: `${head.slice(0, 10)} already has full result ${same}` };
          }
          const path = [NodePath.join(NodeOS.homedir(), ".vite-plus/bin"), process.env.PATH ?? ""].join(":");
          // A plain install: `xwing app install` would link the main checkout's env files into the clone.
          await ctx.exec(["vp", "i"], { cwd: clone, env: { PATH: path } }).run();
          const co = checkoutAt(ctx, clone);
          await ctx
            .exec(["node", "apps/web/node_modules/playwright/cli.js", "install", "--only-shell", "chromium"], {
              cwd: clone,
              env: co.env,
            })
            .run()
            .catch((error: unknown) => {
              throw new Error("Installing Playwright's Chromium for the web suite failed", { cause: error });
            });
          return { head, clone };
        } catch (error) {
          NodeFS.rmSync(clone, { recursive: true, force: true });
          throw error;
        }
      })
      .inline()
      .cores(6);

    p.job("suites", async (ctx: Context) => {
      const prepared = await ctx.output(prepare);
      if (!prepared) throw new Error("prepare output is unavailable");
      if (prepared.skip || !prepared.clone) return ctx.log.info(`Nothing to confirm: ${prepared.skip}`);
      const clone = prepared.clone;
      const evidence = evidenceDir(ctx);
      const logs = NodePath.join(evidence, "suites");
      try {
        await ctx
          .exec([
            "sparkwing", "run", "suite", "--priority", String(priority), "-C", clone,
            "--", "--worktree", clone, "--full", "--evidence", logs,
          ])
          .run();
      } catch (error) {
        const file =
          ctx.args["known-failures"] ||
          NodePath.join(NodeOS.homedir(), "evidence/weavewing/main-green/known-main-failures.md");
        recordFailures(file, prepared.head, ctx.run.id, logs);
        throw error;
      } finally {
        NodeFS.rmSync(clone, { recursive: true, force: true });
      }
    })
      .inline()
      .cores(0.25)
      .needs(prepare);
  },
});
