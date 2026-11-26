import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type EvidenceChangeQa,
  type EvidenceLanding,
  type EvidenceSetQaInput,
  ThreadId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ThreadQaCard } from "./ThreadQaCard";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const landing: EvidenceLanding = {
  id: "2026-11-25-toast",
  title: "Retry count in the toast",
  target: { branch: "main", sha: "3f2a91c0" },
  verifications: [{ label: "unit", result: "pass" }],
  threadId: threadRef.threadId,
  qaThreadId: threadRef.threadId,
  projectId: null,
  landedAt: "2026-11-25T10:00:00.000Z",
  updatedAt: "2026-11-25T10:00:00.000Z",
  changes: [
    {
      id: "toast-retry-count",
      ask: "Show the retry count in the toast.",
      commits: ["7c1e04a"],
      summary: "Toast shows how many times a delivery was retried",
      review: { verdict: "approved", by: "opus", check: "unverified" },
      captures: [],
      gaps: ["Not checked in Safari."],
      qa: {
        state: "pending",
        note: "",
        updatedAt: "2026-11-25T10:00:00.000Z",
        by: "server",
        ref: 1,
        raised: ["gaps"],
      },
    },
  ],
};
const change = landing.changes[0]!;

const sent: EvidenceSetQaInput[] = [];
// The card's QA writes answer as the server would, one second later each time.
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    async ({ input }: { input: EvidenceSetQaInput }) => {
      sent.push(input);
      const value: EvidenceChangeQa = {
        state: input.state,
        note: input.note ?? "",
        updatedAt: new Date(Date.parse(change.qa.updatedAt) + sent.length * 1000).toISOString(),
        by: "user",
      };
      return { _tag: "Success", value };
    }) as never,
}));
vi.mock(import("../../state/evidence"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    evidenceSetQa: { permissionAtom: () => Atom.make(true) } as never,
  };
});

function Card() {
  // Re-renders when the composer changes, as the timeline row does.
  useSyncExternalStore(useComposerDraftStore.subscribe, () =>
    useComposerDraftStore.getState().getComposerDraft(threadRef),
  );
  return <ThreadQaCard threadRef={threadRef} landing={landing} change={change} />;
}

/** Forgets what was sent and every draft when the test ends. */
function fresh(): Disposable {
  sent.length = 0;
  return {
    [Symbol.dispose]: () => {
      sent.length = 0;
      useComposerDraftStore.setState({ draftsByThreadKey: {} });
    },
  };
}

it("settles with Looks good, starts no turn, and keeps focus on the line it collapses to", async () => {
  using _fresh = fresh();
  await using screen = await render(<Card />);
  await expect.element(screen.getByRole("region", { name: /^QA1: Toast shows/ })).toBeVisible();
  await expect.element(screen.getByText("Not checked in Safari.")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Looks good: QA1" }));
  expect(sent).toEqual([{ landingId: landing.id, changeId: change.id, state: "confirmed" }]);
  const line = screen.getByRole("button", { name: /QA1.*Toast shows.*Looks good/ });
  await expect.element(line).toHaveFocus();
  await expect.element(screen.getByText("Confirmed by you")).toBeVisible();
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Reopen QA1" }));
  expect(sent.at(-1)).toMatchObject({ state: "pending" });
  await expect.element(screen.getByRole("button", { name: "Looks good: QA1" })).toHaveFocus();
});

it("puts one Discuss reference in the composer and takes it out again", async () => {
  using _fresh = fresh();
  await using screen = await render(<Card />);
  const discuss = screen.getByRole("button", { name: "Discuss QA1" });

  await userEvent.click(discuss);
  const records = () =>
    useComposerDraftStore.getState().getComposerDraft(threadRef)?.waitingItems ?? [];
  await vi.waitFor(() =>
    expect(records().map((record) => record.label)).toEqual([
      "QA1 · discuss · Toast shows how many times a delivery was retried",
    ]),
  );
  await expect.element(discuss).toHaveAttribute("aria-pressed", "true");
  await expect.element(screen.getByText("In composer")).toBeVisible();
  expect(sent).toEqual([]);

  await userEvent.click(discuss);
  await vi.waitFor(() => expect(records()).toEqual([]));
  await expect.element(discuss).toHaveAttribute("aria-pressed", "false");
  await expect.element(screen.getByText("Open")).toBeVisible();
});

it("dismisses in one click and takes an optional reason afterwards", async () => {
  using _fresh = fresh();
  await using screen = await render(<Card />);

  await userEvent.click(screen.getByRole("button", { name: "Dismiss QA1" }));
  expect(sent).toEqual([{ landingId: landing.id, changeId: change.id, state: "waived" }]);
  await expect.element(screen.getByText("Dismissed")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: /QA1.*Toast shows/ }));
  await userEvent.click(screen.getByRole("button", { name: "Add why QA1 was dismissed" }));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Why QA1 was dismissed" }),
    "Covered by the toast tests.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save reason" }));
  expect(sent.at(-1)).toEqual({
    landingId: landing.id,
    changeId: change.id,
    state: "waived",
    note: "Covered by the toast tests.",
  });
  await expect.element(screen.getByText("Covered by the toast tests.")).toBeVisible();
  // Closing the form by saving, Escape or Cancel hands focus back to the button that opened it.
  const edit = screen.getByRole("button", { name: "Edit why QA1 was dismissed" });
  await expect.element(edit).toHaveFocus();
  await userEvent.click(edit);
  await userEvent.keyboard("{Escape}");
  await expect.element(edit).toHaveFocus();
  await userEvent.click(edit);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await expect.element(edit).toHaveFocus();
  // Escape closes the form from its buttons too, not only from the textarea.
  await userEvent.click(edit);
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("textbox", { name: "Why QA1 was dismissed" }))
    .not.toBeInTheDocument();
  await expect.element(edit).toHaveFocus();
});
