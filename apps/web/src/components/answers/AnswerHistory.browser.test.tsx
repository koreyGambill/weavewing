import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, MessageId, ThreadId, type TrackedAnswersPage } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AnswersSection } from "./AnswersSection";

vi.mock("@t3tools/client-runtime/state/runtime", { spy: true });
vi.mock("./trackedAnswers-web-state", () => ({
  useUpdateTrackedAsk: () => ({ canUpdate: true, submit: async () => true }),
}));

const at = "2026-11-01T12:00:00.000Z";
const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("current"));
const archive: TrackedAnswersPage["entries"][number] = {
  threadId: ThreadId.make("archived"),
  threadTitle: "Previous thread",
  archived: true,
  ask: {
    id: "A1",
    state: "answered",
    question: "What resets the counter?",
    askedInMessageId: MessageId.make("message"),
    createdAt: at,
    closedAt: null,
    answers: [{ n: 1, text: "The reconnect handler.", answeredAt: at, runId: null }],
    followUps: [],
  },
};

it("keeps an archived answer readable without sending the user to an unavailable composer", async () => {
  vi.mocked(executeAtomQuery).mockReset();
  vi.mocked(executeAtomQuery).mockResolvedValueOnce(AsyncResult.success({ entries: [archive] }));
  await using screen = await render(
    <AnswersSection threadRef={threadRef} scope="all" actions={null} />,
  );
  await screen.getByRole("button", { name: /What resets the counter/ }).click();
  await expect.element(screen.getByText("The reconnect handler.", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Restore this archived thread/)).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Show in chat" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Discuss" })).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Actions for A1" }).click();
  await expect
    .element(screen.getByRole("menuitem", { name: "Show answer" }))
    .not.toBeInTheDocument();
});
