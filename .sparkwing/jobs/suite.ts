import { definePipeline } from "@sparkwing/sdk";

import { checkout, checkoutArgs } from "../lib/checkout.ts";
import { everySuite, isSuiteName, SUITES } from "../lib/suites.ts";

definePipeline({
  name: "Suite",
  short: "One full test suite (web, server or packages), or all three, admitted by its cores",
  help:
    "Runs the named suite as ci does, in any checkout with dependencies installed, and reports every failing " +
    "file or package. Admission holds the suite's cores (web 6, server 6, packages 4) for the whole run. " +
    "--full runs all three one after another as batch work, which is the full result main-health reads.",
  args: [
    ...checkoutArgs,
    { name: "suite", type: "string", description: "web, server or packages" },
    { name: "full", type: "bool", description: "Run web, server and packages one after another" },
  ],
  plan(p, run) {
    // Discovery plans without arguments, so an invalid choice fails when the job runs.
    const full = run.args.full === "true";
    const name = run.args.suite ?? "";
    const suite = isSuiteName(name) ? SUITES[name] : undefined;
    // Every suite in a row is long and latency-insensitive, so it waits behind interactive work.
    if (full) p.admissionClass("batch");
    p.job("suite", (ctx) => {
      if (full === Boolean(name)) throw new Error("Pass either --suite web|server|packages or --full");
      if (full) return everySuite(ctx, checkout(ctx));
      if (!suite) throw new Error(`--suite must be web, server or packages, got "${name}"`);
      return suite.run(ctx, checkout(ctx));
    })
      .inline()
      .cores(full ? Math.max(...Object.values(SUITES).map((each) => each.cores)) : (suite?.cores ?? 0.25));
  },
});
