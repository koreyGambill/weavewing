import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskCardOutcome, taskCardStatus } from "./taskCard.logic";

describe("taskCardStatus", () => {
  it("tells the user's own close from the agent's record", () => {
    expect(taskCardStatus({ state: "done", settledBy: "user" }, false)).toBe("done-by-you");
    expect(taskCardStatus({ state: "done" }, false)).toBe("done-by-you");
    expect(taskCardStatus({ state: "done", settledBy: "agent" }, false)).toBe("recorded");
    expect(taskCardStatus({ state: "dropped", settledBy: "agent" }, false)).toBe("dismissed");
  });

  it("shows a reference in this composer before a sent discussion", () => {
    const discussed = { state: "open" as const, discussedInMessageId: MessageId.make("m") };
    expect(taskCardStatus({ state: "open" }, false)).toBe("open");
    expect(taskCardStatus(discussed, false)).toBe("discussing");
    expect(taskCardStatus(discussed, true)).toBe("in-composer");
  });
});

describe("taskCardOutcome", () => {
  it("quotes a recorded note and otherwise leaves the outcome to the badge", () => {
    expect(taskCardOutcome({ state: "open" })).toBeNull();
    expect(taskCardOutcome({ state: "done", note: " rotated it " })).toBe("“rotated it”");
    expect(taskCardOutcome({ state: "done" })).toBe("");
    expect(taskCardOutcome({ state: "dropped" })).toBe("");
  });
});
