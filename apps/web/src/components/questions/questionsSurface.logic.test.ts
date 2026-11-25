import { describe, expect, it } from "vite-plus/test";

import { questionSurfaceIdsToClose } from "./questionsSurface.logic";

describe("questionSurfaceIdsToClose", () => {
  const surfaces = [
    { id: "notes", kind: "notes" },
    { id: "questions", kind: "questions" },
  ] as const;

  it.each([
    [false, ["questions"]],
    [true, []],
    [null, []],
  ] as const)("closes Questions tabs only when the setting is known off: %s", (enabled, ids) => {
    expect(questionSurfaceIdsToClose(surfaces, enabled)).toEqual(ids);
  });
});
