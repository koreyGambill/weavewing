import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadUpdateAskInput,
  type TrackedAsk,
} from "@t3tools/contracts";
import { useState } from "react";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useThreadTrackedAsks } from "../../state/threads";
import { AnswersSection } from "./AnswersSection";
import { TrackAnswerToggle } from "./TrackAnswerToggle";
import { ThreadAnswerCard } from "./ThreadAnswerCard";

const commands = vi.hoisted(() => ({
  update: vi.fn<(input: ThreadUpdateAskInput) => Promise<boolean>>(),
}));

vi.mock("./trackedAnswers-web-state", () => ({
  useUpdateTrackedAsk: () => ({ canUpdate: true, submit: commands.update }),
}));

vi.mock("../../state/threads", { spy: true });

it("explains why a rolled-back question cannot be revealed", async () => {
  const at = "2026-11-01T12:00:00.000Z";
  const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
  vi.mocked(useThreadTrackedAsks).mockReturnValue([
    {
      id: "A1",
      state: "withdrawn",
      withdrawnBecause: "rollback",
      question: "What resets the counter?",
      askedInMessageId: MessageId.make("removed"),
      createdAt: at,
      closedAt: null,
      answers: [],
      followUps: [],
    },
  ]);
  await using screen = await render(
    <AnswersSection threadRef={threadRef} scope="thread" actions={null} />,
  );
  await screen.getByRole("button", { name: /What resets the counter/ }).click();
  await expect
    .element(screen.getByText("The asking message was removed by a rollback."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Show in chat" }))
    .not.toBeInTheDocument();
});

it("reaches Track answer before Send and changes its pressed state with Space and Enter", async () => {
  function Composer() {
    const [pressed, setPressed] = useState(false);
    return (
      <form>
        <textarea aria-label="Message" />
        <TrackAnswerToggle pressed={pressed} compact onToggle={() => setPressed(!pressed)} />
        <button type="button">Send</button>
      </form>
    );
  }
  await using screen = await render(<Composer />);
  const toggle = screen.getByRole("button", { name: "Track answer" });
  await screen.getByRole("textbox", { name: "Message" }).click();
  await userEvent.tab();
  await expect.element(toggle).toHaveFocus();
  await userEvent.keyboard(" ");
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Enter}");
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "Send" })).toHaveFocus();
});

it("returns focus to the collapsed answer after Got it and to Got it after Reopen", async () => {
  const at = "2026-11-01T12:00:00.000Z";
  const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
  const ask: TrackedAsk = {
    id: "A1",
    state: "answered",
    question: "What resets the counter?",
    askedInMessageId: MessageId.make("message"),
    createdAt: at,
    closedAt: null,
    answers: [{ n: 1, text: "The reconnect handler.", answeredAt: at, runId: null }],
    followUps: [],
  };
  commands.update.mockReset();
  function Card() {
    const [closed, setClosed] = useState(false);
    commands.update.mockImplementation(async (input) => {
      setClosed(input.action === "close");
      return true;
    });
    return (
      <ThreadAnswerCard
        ask={{ ...ask, state: closed ? "closed" : "answered" }}
        answer={ask.answers[0]!}
        threadRef={threadRef}
        onAsked={() => {}}
        onDiscuss={() => {}}
        discussInComposer={false}
      />
    );
  }
  await using screen = await render(<Card />);
  const gotIt = screen.getByRole("button", { name: "Got it" });
  await gotIt.click();
  await expect
    .element(screen.getByRole("button", { name: /What resets the counter/ }))
    .toHaveFocus();
  await screen.getByRole("button", { name: "Reopen" }).click();
  await expect.element(gotIt).toHaveFocus();
  expect(commands.update.mock.calls.map(([input]) => input.action)).toEqual(["close", "reopen"]);
});
