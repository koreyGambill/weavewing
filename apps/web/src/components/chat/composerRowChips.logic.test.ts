import { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveComposerRowPullRequestText,
  resolveThreadAutomations,
  summarizeComposerRowAutomations,
} from "./composerRowChips.logic";

describe("resolveComposerRowPullRequestText", () => {
  it("shows nothing for a thread with no pull request", () => {
    expect(resolveComposerRowPullRequestText({ badge: null, number: undefined })).toBeNull();
  });

  it("shows the number alone for one pull request, whatever its state", () => {
    for (const state of ["open", "merged", "closed", "draft"] as const) {
      expect(
        resolveComposerRowPullRequestText({
          badge: { kind: "pull-request", others: 0, state },
          number: 42,
        }),
      ).toEqual({ primary: "#42", more: 0, value: "#42" });
    }
    // A pull request found for the branch, with no linked list, has no badge.
    expect(resolveComposerRowPullRequestText({ badge: null, number: 7 })?.value).toBe("#7");
  });

  it("adds how many more the thread links", () => {
    expect(
      resolveComposerRowPullRequestText({
        badge: { kind: "pull-request", others: 2, state: "open" },
        number: 42,
      }),
    ).toEqual({ primary: "#42", more: 2, value: "#42 +2" });
    expect(
      resolveComposerRowPullRequestText({
        badge: { kind: "stack", layers: 3, state: "open" },
        number: 42,
      })?.value,
    ).toBe("#42 +2");
  });

  it("counts a stack's layers when it has no current pull request", () => {
    expect(
      resolveComposerRowPullRequestText({
        badge: { kind: "stack", layers: 3, state: "merged" },
        number: undefined,
      })?.value,
    ).toBe("3");
  });
});

describe("resolveThreadAutomations", () => {
  const threadId = ThreadId.make("thread-a");
  const nightly = { id: ScheduledTaskId.make("nightly"), title: "Nightly", threadId: null };
  const sweep = { id: ScheduledTaskId.make("sweep"), title: "Sweep", threadId };
  const elsewhere = {
    id: ScheduledTaskId.make("elsewhere"),
    title: "Elsewhere",
    threadId: ThreadId.make("thread-b"),
  };

  it("is empty with no automation", () => {
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: undefined, tasks: [nightly] }),
    ).toEqual([]);
    expect(summarizeComposerRowAutomations([])).toBeNull();
  });

  it("names the automation that started the thread", () => {
    const automations = resolveThreadAutomations({
      threadId,
      startedByTaskId: nightly.id,
      tasks: [nightly, elsewhere],
    });
    expect(automations).toEqual([{ id: nightly.id, title: "Nightly", relation: "started" }]);
    expect(summarizeComposerRowAutomations(automations)?.value).toBe("Nightly");
  });

  it("says Automation while the list has no title for the starter", () => {
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: nightly.id, tasks: null }),
    ).toEqual([{ id: nightly.id, title: "Automation", relation: "started" }]);
  });

  it("finds tasks that send to the thread", () => {
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: null, tasks: [nightly, sweep] }),
    ).toEqual([{ id: sweep.id, title: "Sweep", relation: "targets" }]);
  });

  it("lists a task that both started and targets the thread once", () => {
    const started = { ...nightly, threadId };
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: started.id, tasks: [started] }),
    ).toEqual([{ id: started.id, title: "Nightly", relation: "started" }]);
  });

  it("leads with the starter and counts the rest", () => {
    const automations = resolveThreadAutomations({
      threadId,
      startedByTaskId: nightly.id,
      tasks: [sweep, nightly],
    });
    expect(automations.map((automation) => automation.relation)).toEqual(["started", "targets"]);
    expect(summarizeComposerRowAutomations(automations)).toMatchObject({
      title: "Nightly",
      more: 1,
      value: "Nightly +1",
      description: "Automations: Nightly, Sweep",
    });
  });
});
