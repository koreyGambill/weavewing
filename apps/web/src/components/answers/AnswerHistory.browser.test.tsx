import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, MessageId, ThreadId, type TrackedAnswersPage } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
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
    answers: [{ n: 1, text: "The **reconnect** handler.", answeredAt: at, runId: null }],
    followUps: [],
  },
};

it("keeps an archived answer readable without sending the user to an unavailable composer", async () => {
  vi.mocked(executeAtomQuery).mockReset();
  vi.mocked(executeAtomQuery).mockResolvedValueOnce(AsyncResult.success({ entries: [archive] }));
  await using screen = await render(
    <AnswersSection threadRef={threadRef} scope="all" actions={null} />,
  );
  const row = screen.getByRole("button", { name: /What resets the counter/ });
  await expect.element(row).toBeVisible();
  expect(row.element().textContent).toContain("The reconnect handler.");
  expect(row.element().textContent).not.toContain("**reconnect**");
  await row.click();
  await expect.element(screen.getByText("reconnect", { exact: true })).toBeVisible();
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

it("keeps Show more available after a page request fails and retries that page", async () => {
  vi.mocked(executeAtomQuery).mockReset();
  vi.mocked(executeAtomQuery)
    .mockResolvedValueOnce(AsyncResult.success({ entries: [archive], cursor: "next" }))
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Could not load this page."))))
    .mockResolvedValueOnce(
      AsyncResult.success({
        entries: [{ ...archive, ask: { ...archive.ask, id: "A2", question: "When is it saved?" } }],
      }),
    );
  await using screen = await render(
    <AnswersSection threadRef={threadRef} scope="all" actions={null} />,
  );
  const more = screen.getByRole("button", { name: "Show more" });
  await more.click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Could not load this page.");
  await expect
    .element(screen.getByRole("button", { name: /What resets the counter/ }))
    .toBeVisible();
  await more.click();
  await expect.element(screen.getByRole("button", { name: /When is it saved/ })).toBeVisible();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});
