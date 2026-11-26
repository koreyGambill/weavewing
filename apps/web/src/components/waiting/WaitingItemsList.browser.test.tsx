import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  ThreadId,
  type ThreadWorkspace,
  type WaitingItemSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { WaitingItemsList } from "./WaitingItemsList";
import { groupWaitingItems } from "./waitingStrip.logic";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const sent: unknown[] = [];
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    async ({ input }: { input: unknown }) => {
      sent.push(input);
      return { _tag: "Success", value: {} };
    }) as never,
}));
vi.mock(import("../../state/evidence"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    evidenceSetQa: { permissionAtom: () => Atom.make(true) } as never,
  };
});
vi.mock(import("../../state/threadQuestions"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    threadTaskUpdate: { permissionAtom: () => Atom.make(true) } as never,
  };
});

const waiting: ReadonlyArray<WaitingItemSummary> = [
  { kind: "qa", ref: "QA1", key: "landing-1/toast", title: "Toast shows the count", state: "open" },
  { kind: "qa", ref: "QA2", key: "landing-1/close", title: "Close button moved", state: "problem" },
  { kind: "task", ref: "T1", key: "task-1", title: "Rotate the webhook secret", state: "open" },
];
const workspace: ThreadWorkspace = {
  threadId: threadRef.threadId,
  revision: 3,
  items: [],
  artifacts: [],
  questions: [],
  summaryNotes: "",
  childPreamble: "",
  updatedAt: null,
};

function List({ width, unlisted = 0 }: { width: number; unlisted?: number }) {
  return (
    <div style={{ width }}>
      <WaitingItemsList
        threadRef={threadRef}
        groups={groupWaitingItems(waiting)}
        workspace={workspace}
        unlisted={unlisted}
        hasQuestions
      />
    </div>
  );
}

it("answers each kind in one click and leaves a problem to the agent", async () => {
  sent.length = 0;
  await using screen = await render(<List width={800} />);
  await expect.element(screen.getByRole("region", { name: "QA" })).toBeVisible();
  await expect.element(screen.getByRole("region", { name: "Tasks" })).toBeVisible();
  await expect.element(screen.getByText("Agent fixing")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Looks good: QA2" })).toBeDisabled();

  await userEvent.click(screen.getByRole("button", { name: "Looks good: QA1" }));
  // The settled row is about to leave, so focus moves on to the next row's title.
  await expect.element(screen.getByRole("button", { name: /^QA2: Close button/ })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "Done: T1" }));
  expect(sent).toEqual([
    { landingId: "landing-1", changeId: "toast", state: "confirmed" },
    {
      threadId: threadRef.threadId,
      expectedRevision: 3,
      changes: [{ id: "task-1", state: "done" }],
    },
  ]);

  await expect.element(screen.getByText(/more not listed here/)).not.toBeInTheDocument();
});

it("says how many items the capped rows leave out and where to see them", async () => {
  await using screen = await render(<List width={800} unlisted={30} />);
  await expect.element(screen.getByText("30 more not listed here. See them in")).toBeVisible();
  for (const name of ["Questions", "Evidence", "Checklist"])
    await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
});

it("keeps only each row's title and answer under 600 px", async () => {
  await page.viewport(390, 800);
  await using screen = await render(<List width={360} />);
  await expect.element(screen.getByRole("button", { name: "Done: T1" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /T1.*Rotate/ })).toBeVisible();
  await expect.element(screen.getByText("Agent fixing")).not.toBeVisible();
  const list = screen.getByRole("group", { name: "Waiting on you" }).element();
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
});
