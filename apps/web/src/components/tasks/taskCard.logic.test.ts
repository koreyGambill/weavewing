import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskCardOutcome, taskCardStatus } from "./taskCard.logic";

describe("taskCardStatus", () => {
  it("tells the user's own close from the agent's record", () => {
    expect(taskCardStatus({ state: "done", settledBy: "user" }, false)).toBe("done-by-you");
    expect(taskCardStatus({ state: "done" }, false)).toBe("done-by-you");
    expect(taskCardStatus({ state: "done", settledBy: "agent" }, false)).toBe("recorded");
    expect(taskCardStatus({ state: "dropped", settledBy: "agent" }, false)).toBe("cancelled");
  });

  it("shows a reference in this composer before a sent discussion", () => {
    const discussed = { state: "open" as const, discussedInMessageId: MessageId.make("m") };
    expect(taskCardStatus({ state: "open" }, false)).toBe("open");
    expect(taskCardStatus(discussed, false)).toBe("discussing");
    expect(taskCardStatus(discussed, true)).toBe("in-composer");
  });
});

describe("taskCardOutcome", () => {
  it("quotes a recorded note, else says how the task closed", () => {
    expect(taskCardOutcome({ state: "open" })).toBeNull();
    expect(taskCardOutcome({ state: "done", note: " rotated it " })).toBe("“rotated it”");
    expect(taskCardOutcome({ state: "done" })).toBe("Done");
    expect(taskCardOutcome({ state: "dropped" })).toBe("Cancelled");
    expect(taskCardOutcome({ state: "dropped", settledBy: "agent" })).toBe(
      "Cancelled by the agent",
    );
  });
});
