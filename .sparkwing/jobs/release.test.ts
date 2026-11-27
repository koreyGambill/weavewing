import assert from "node:assert/strict";
import { test } from "node:test";

import { Git, Plan } from "@sparkwing/sdk";

import { releaseBuildPipeline, releasePipeline } from "./release.ts";

test("channel policy gates builds on full CI only when required and promotion reuses drafts", async () => {
  const context = {
    id: "simulation", pipeline: "release", args: { version: "0.1.0", stage: "plan" },
    dryRun: false, noMemo: false, runner: { name: "simulation", type: "local", labels: [] },
    git: new Git("/simulation", { repo: "simulation", branch: "main", commit: "source" }), trigger: { source: "manual" },
  };
  const plan = new Plan();
  await releasePipeline.plan(plan, context);
  const inspect = (value: Plan) => (value as Plan & { toDoc(): { jobs: { id: string; deps?: string[]; children?: unknown; steps?: { id: string; needs?: string[] }[] }[] } }).toDoc();
  const jobs = inspect(plan).jobs;
  assert.deepEqual(jobs.find((job) => job.id === "mac")?.deps, ["preflight", "ci"]);
  assert.deepEqual(jobs.find((job) => job.id === "build")?.deps, ["preflight", "ci"]);
  assert.ok(jobs.find((job) => job.id === "publish-draft")?.deps?.includes("build"));
  // Sparkwing only lets a job read outputs of jobs it depends on; publish-draft reads ci's.
  assert.ok(jobs.find((job) => job.id === "publish-draft")?.deps?.includes("ci"));
  const smoke = new Plan();
  const nightlyArgs = { ...context.args, version: "0.2.0-nightly.20261117.1", channel: "test" };
  await releasePipeline.plan(smoke, { ...context, args: nightlyArgs });
  assert.equal(inspect(smoke).jobs.some((job) => job.id === "ci"), false);
  assert.deepEqual(inspect(smoke).jobs.find((job) => job.id === "mac")?.deps, ["preflight"]);
  assert.deepEqual(inspect(smoke).jobs.find((job) => job.id === "build")?.deps, ["preflight"]);
  for (const id of ["build", "mac", "publish-draft"])
    assert.ok(inspect(smoke).jobs.some((job) => job.id === id));
  const build = new Plan();
  await releaseBuildPipeline.plan(build, { ...context, args: nightlyArgs });
  const buildSteps = inspect(build).jobs.find((job) => job.id === "build")?.steps;
  assert.deepEqual(buildSteps?.find((step) => step.id === "assert-clean-bundle")?.needs, ["bundle"]);
  assert.deepEqual(buildSteps?.find((step) => step.id === "linux-x64")?.needs, ["bundle", "assert-clean-bundle"]);
  assert.deepEqual(buildSteps?.find((step) => step.id === "win-x64")?.needs, ["bundle", "linux-x64", "assert-clean-bundle"]);
  const forced = new Plan();
  await releasePipeline.plan(forced, { ...context, args: { ...nightlyArgs, "force-ci": "true" } });
  assert.ok(inspect(forced).jobs.some((job) => job.id === "ci"));
  assert.ok(inspect(forced).jobs.find((job) => job.id === "publish-draft")?.deps?.includes("ci"));
  const promote = new Plan();
  await releasePipeline.plan(promote, { ...context, args: { ...context.args, stage: "promote" } });
  assert.deepEqual(inspect(promote).jobs.map((job) => job.id), ["promote"]);
  assert.equal(inspect(promote).jobs[0]?.children, undefined);
  const invalidArgs: Record<string, string>[] = [{ stage: "promote", "force-ci": "true" }, { stage: "plan", "force-ci": "true", "build-only": "true" }];
  for (const args of invalidArgs) {
    await assert.rejects(async () => releasePipeline.plan(new Plan(), { ...context, args: { ...context.args, ...args } }), /force-ci/);
  }
});
