import { definePipeline } from "@sparkwing/sdk";

import { checkout, checkoutArgs } from "../lib/checkout.ts";
import { isSuiteName, SUITES } from "../lib/suites.ts";

definePipeline({
  name: "Suite",
  short: "One full test suite (web, server or packages), admitted by its cores",
  help:
    "Runs the named suite as ci does, in any checkout with dependencies installed, and reports every failing " +
    "file or package. Admission holds the suite's cores (web 6, server 6, packages 4) for the whole run.",
  args: [
    ...checkoutArgs,
    { name: "suite", type: "string", required: true, description: "web, server or packages" },
  ],
  plan(p, run) {
    // Discovery plans without arguments, so an unknown suite fails when the job runs.
    const name = run.args.suite ?? "";
    const suite = isSuiteName(name) ? SUITES[name] : undefined;
    p.job("suite", (ctx) => {
      if (!suite) throw new Error(`--suite must be web, server or packages, got "${name}"`);
      return suite.run(ctx, checkout(ctx));
    })
      .inline()
      .cores(suite?.cores ?? 0.25);
  },
});
