import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const withSiblings = (siblings: ReadonlyArray<string>) =>
  createOxlintRuleHarness("t3code/no-case-colliding-modules", {
    filename: "ComposerRow.tsx",
    siblings,
  });

describe("t3code/no-case-colliding-modules", () => {
  withSiblings(["ComposerRow.test.tsx", "ComposerRow.logic.ts", "composerRowItems.ts"]).valid(
    "allows siblings whose names differ by more than case",
    "export {};",
  );
  withSiblings(["composerRow.css"]).valid(
    "allows a stylesheet that shares the name, because it is imported with its extension",
    "export {};",
  );
  withSiblings(["composerRow.ts"]).invalid(
    "rejects a module whose name differs only by case",
    "export {};",
    (output) => assert.include(output, "composerRow.ts differs from this file only by case"),
  );
  withSiblings(["COMPOSERROW.mjs"]).invalid(
    "rejects a case collision across JavaScript extensions",
    "export {};",
  );
});
