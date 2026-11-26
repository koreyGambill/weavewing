import { ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationRelationLabel,
  resolveComposerRowBranchPullRequest,
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

describe("resolveComposerRowBranchPullRequest", () => {
  const pr = {
    number: 7,
    title: "Retry count",
    url: "https://github.com/acme/render/pull/7",
    baseRef: "main",
    headRef: "feature/a",
    state: "open" as const,
  };
  const status = { refName: "feature/a", pr };

  it("uses the branch's open pull request while the picker shows the thread's branch", () => {
    expect(
      resolveComposerRowBranchPullRequest({
        threadBranch: "feature/a",
        pickerBranch: "feature/a",
        gitStatus: status,
      }),
    ).toEqual(pr);
    // No picker in the row, such as an embedded view.
    expect(
      resolveComposerRowBranchPullRequest({
        threadBranch: "feature/a",
        pickerBranch: undefined,
        gitStatus: status,
      }),
    ).toEqual(pr);
  });

  it("shows none while the picker shows a ref the thread has not recorded", () => {
    // A checkout to feature/b is in flight: the picker already shows it, the status does not.
    expect(
      resolveComposerRowBranchPullRequest({
        threadBranch: "feature/a",
        pickerBranch: "feature/b",
        gitStatus: status,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadAutomations", () => {
  const threadId = ThreadId.make("thread-a");
  const nightly = {
    id: ScheduledTaskId.make("nightly"),
    title: "Nightly",
    threadId: null,
    enabled: true,
  };
  const sweep = { id: ScheduledTaskId.make("sweep"), title: "Sweep", threadId, enabled: false };
  const elsewhere = {
    id: ScheduledTaskId.make("elsewhere"),
    title: "Elsewhere",
    threadId: ThreadId.make("thread-b"),
    enabled: true,
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
    expect(automations).toEqual([
      { id: nightly.id, title: "Nightly", relation: "started", enabled: true },
    ]);
    expect(summarizeComposerRowAutomations(automations)?.value).toBe("Nightly");
  });

  it("offers nothing until the list arrives", () => {
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: nightly.id, tasks: null }),
    ).toEqual([]);
  });

  it("leaves out a starter that was deleted, keeping the tasks that still send here", () => {
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: nightly.id, tasks: [sweep] }),
    ).toEqual([{ id: sweep.id, title: "Sweep", relation: "targets", enabled: false }]);
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: nightly.id, tasks: [elsewhere] }),
    ).toEqual([]);
  });

  it("finds tasks that send to the thread and says when one is paused", () => {
    const [target] = resolveThreadAutomations({
      threadId,
      startedByTaskId: null,
      tasks: [nightly, sweep],
    });
    expect(target).toEqual({ id: sweep.id, title: "Sweep", relation: "targets", enabled: false });
    expect(automationRelationLabel(target!)).toBe("Sends here · paused");
  });

  it("lists a task that both started and targets the thread once", () => {
    const started = { ...nightly, threadId };
    expect(
      resolveThreadAutomations({ threadId, startedByTaskId: started.id, tasks: [started] }),
    ).toEqual([{ id: started.id, title: "Nightly", relation: "started", enabled: true }]);
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
