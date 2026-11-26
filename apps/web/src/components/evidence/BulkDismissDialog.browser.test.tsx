import {
  EVIDENCE_BULK_DISMISS_DEFAULT_REASON,
  type EnvironmentId,
  type EvidenceBulkSetQaInput,
  type EvidenceChangeKey,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { BulkDismissDialog } from "./BulkDismissDialog";
import { bulkDismissBefore } from "./bulkDismiss.logic";
import { useBulkDismissStore } from "./bulkDismissStore";

const key = (changeId: string): EvidenceChangeKey => ({ landingId: "old", changeId });
const sent: EvidenceBulkSetQaInput[] = [];
const sentTo: string[] = [];
const server: { failNextList: boolean; hold: Promise<void> | null } = {
  failNextList: false,
  hold: null,
};
// Four changes waited before 2026-11-25 and two before 2026-11-01, as the server would list.
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    async ({ environmentId, input }: { environmentId: string; input: EvidenceBulkSetQaInput }) => {
      sent.push(input);
      sentTo.push(environmentId);
      if ("dryRun" in input && environmentId === "env-2") {
        await server.hold;
        return { _tag: "Success", value: { count: 1, changes: [key("z")] } };
      }
      if ("dryRun" in input) {
        if (server.failNextList) {
          server.failNextList = false;
          return { _tag: "Failure", error: new Error("offline") };
        }
        const early = DateTime.formatIso(input.before) === bulkDismissBefore("2026-11-01");
        const changes = (early ? ["a", "b"] : ["a", "b", "c", "d"]).map(key);
        return { _tag: "Success", value: { count: changes.length, changes } };
      }
      return { _tag: "Success", value: { count: input.changes.length } };
    }) as never,
}));

const environmentId = "env-1" as EnvironmentId;
const open = () => {
  sent.length = 0;
  sentTo.length = 0;
  useBulkDismissStore.getState().start(environmentId);
};

it("shows the count, needs a reason, and dismisses only the listed changes", async () => {
  open();
  const onClose = vi.fn();
  await using screen = await render(
    <BulkDismissDialog environmentId={environmentId} onClose={onClose} />,
  );
  const day = screen.getByLabelText("Landed before");
  await userEvent.fill(day, "2026-11-25");
  await expect.element(screen.getByText("4 changes will be dismissed.")).toBeVisible();
  const reason = screen.getByLabelText("Reason");
  await expect.element(reason).toHaveValue(EVIDENCE_BULK_DISMISS_DEFAULT_REASON);
  expect(sent.every((input) => "dryRun" in input)).toBe(true);

  await userEvent.clear(reason);
  await expect.element(screen.getByText("Say why they are dismissed.")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Dismiss 4 changes" })).toBeDisabled();

  await userEvent.fill(reason, "backlog cleared 2026-11-25, not individually checked");
  await userEvent.fill(day, "2026-11-01");
  await expect.element(screen.getByText("2 changes will be dismissed.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss 2 changes" }));
  const dismissals = sent.filter((input) => !("dryRun" in input));
  expect(dismissals).toHaveLength(1);
  expect(dismissals[0]).toMatchObject({
    note: "backlog cleared 2026-11-25, not individually checked",
    changes: [key("a"), key("b")],
  });
  expect(onClose).toHaveBeenCalledOnce();
});

it("offers a retry when the count does not load", async () => {
  open();
  await using screen = await render(
    <BulkDismissDialog environmentId={environmentId} onClose={() => undefined} />,
  );
  await expect.element(screen.getByText(/will be dismissed/)).toBeVisible();
  server.failNextList = true;
  await userEvent.fill(screen.getByLabelText("Landed before"), "2026-11-25");
  await expect.element(screen.getByText("The count did not load.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await expect.element(screen.getByText("4 changes will be dismissed.")).toBeVisible();
});

it("keeps the day and reason when the dialog unmounts and comes back", async () => {
  open();
  const first = await render(
    <BulkDismissDialog environmentId={environmentId} onClose={() => undefined} />,
  );
  await userEvent.fill(first.getByLabelText("Landed before"), "2026-11-01");
  await userEvent.fill(first.getByLabelText("Reason"), "cleared before the release");
  await first[Symbol.asyncDispose]();
  await using screen = await render(
    <BulkDismissDialog environmentId={environmentId} onClose={() => undefined} />,
  );
  await expect.element(screen.getByLabelText("Landed before")).toHaveValue("2026-11-01");
  await expect.element(screen.getByLabelText("Reason")).toHaveValue("cleared before the release");
});

it("never shows one environment's count in another, with the dialog open", async () => {
  open();
  let release = () => undefined as void;
  server.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const screen = await render(
    <BulkDismissDialog environmentId={environmentId} onClose={() => undefined} />,
  );
  await userEvent.fill(screen.getByLabelText("Landed before"), "2026-11-25");
  await expect.element(screen.getByText("4 changes will be dismissed.")).toBeVisible();
  // The user switches environment while the dialog is open there.
  const other = "env-2" as EnvironmentId;
  useBulkDismissStore.getState().start(other);
  await screen.rerender(<BulkDismissDialog environmentId={other} onClose={() => undefined} />);
  await expect.element(screen.getByText("Counting…")).toBeVisible();
  await expect.element(screen.getByText("4 changes will be dismissed.")).not.toBeInTheDocument();
  release();
  await expect.element(screen.getByText("1 change will be dismissed.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss 1 change" }));
  expect(sentTo.at(-1)).toBe("env-2");
  expect(sent.at(-1)).toMatchObject({ changes: [key("z")] });
  server.hold = null;
  await screen[Symbol.asyncDispose]();
});
