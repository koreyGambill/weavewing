import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId, type TrackedAsk } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { TrackedAskActions } from "./TrackedAskActions";

const command = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("./trackedAnswers-web-state", () => ({
  useUpdateTrackedAsk: () => ({ canUpdate: true, submit: command.submit }),
}));

it("keeps focus on a marker while withdrawing or restoring its ask", async () => {
  const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
  function Marker() {
    const [withdrawn, setWithdrawn] = useState(false);
    const ask: TrackedAsk = {
      id: "A1",
      question: "What resets the counter?",
      askedInMessageId: MessageId.make("message"),
      createdAt: "2026-11-01T12:00:00.000Z",
      state: withdrawn ? "withdrawn" : "owed",
      ...(withdrawn ? { withdrawnBecause: "user" } : {}),
      closedAt: null,
      answers: [],
      followUps: [],
    };
    command.submit.mockImplementation(async ({ action }: { action: string }) => {
      await pending;
      setWithdrawn(action === "withdraw");
      return true;
    });
    return <TrackedAskActions ask={ask} threadRef={threadRef} onShow={() => {}} />;
  }
  let accept: () => void;
  let pending = new Promise<void>((resolve) => {
    accept = resolve;
  });
  await using screen = await render(<Marker />);
  const trigger = screen.getByRole("button", { name: "Actions for A1" });
  for (const action of ["Withdraw", "Restore"]) {
    await trigger.click();
    await screen.getByRole("menuitem", { name: action }).click();
    await expect.element(trigger).toHaveFocus();
    accept!();
    await expect.element(trigger).not.toHaveAttribute("aria-busy", "true");
    pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
  }
  expect(command.submit.mock.calls.map(([input]) => input.action)).toEqual(["withdraw", "restore"]);
});
