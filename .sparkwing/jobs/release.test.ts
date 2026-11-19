import assert from "node:assert/strict";
import { test } from "node:test";

import { Git, Plan } from "@sparkwing/sdk";

import { releasePipeline } from "./release.ts";

test("Mac builds can start with local bundling while promotion only verifies assets", async () => {
  const context = {
    id: "simulation", pipeline: "release", args: { version: "0.1.0", stage: "plan" },
    dryRun: false, noMemo: false, runner: { name: "simulation", type: "local", labels: [] },
    git: new Git("/simulation", { repo: "simulation", branch: "main", commit: "source" }), trigger: { source: "manual" },
  };
  const plan = new Plan();
  await releasePipeline.plan(plan, context);
  const inspect = (value: Plan) => (value as Plan & { toDoc(): { jobs: { id: string; deps?: string[]; children?: unknown }[] } }).toDoc();
  const jobs = inspect(plan).jobs;
  assert.deepEqual(jobs.find((job) => job.id === "mac")?.deps, ["preflight", "ci"]);
  assert.deepEqual(jobs.find((job) => job.id === "bundle")?.deps, ["preflight", "ci"]);
  assert.ok(jobs.find((job) => job.id === "win-x64")?.deps?.includes("linux-x64"));
  const promote = new Plan();
  await releasePipeline.plan(promote, { ...context, args: { ...context.args, stage: "promote" } });
  assert.deepEqual(inspect(promote).jobs.map((job) => job.id), ["promote"]);
  assert.equal(inspect(promote).jobs[0]?.children, undefined);
  const invalidArgs: Record<string, string>[] = [{ stage: "promote", "force-ci": "true" }, { stage: "plan", "force-ci": "true", "build-only": "true" }];
  for (const args of invalidArgs) {
    await assert.rejects(async () => releasePipeline.plan(new Plan(), { ...context, args: { ...context.args, ...args } }), /force-ci/);
  }
});
