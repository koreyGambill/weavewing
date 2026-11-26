import {
  EVIDENCE_BULK_DISMISS_DEFAULT_REASON,
  type EnvironmentId,
  type EvidenceBulkSetQaInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { BulkDismissDialog } from "./BulkDismissDialog";
import { bulkDismissBefore } from "./bulkDismiss.logic";

const sent: EvidenceBulkSetQaInput[] = [];
// Four changes waited before 2026-11-25 and two before 2026-11-01, as the server would count.
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    async ({ input }: { input: EvidenceBulkSetQaInput }) => {
      sent.push(input);
      const count = input.before === bulkDismissBefore("2026-11-01") ? 2 : 4;
      return { _tag: "Success", value: { count } };
    }) as never,
}));

it("shows the count, needs a reason, and dismisses only once confirmed", async () => {
  sent.length = 0;
  const onClose = vi.fn();
  await using screen = await render(
    <BulkDismissDialog environmentId={"env-1" as EnvironmentId} onClose={onClose} />,
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
  expect(sent.filter((input) => !("dryRun" in input))).toEqual([
    {
      before: bulkDismissBefore("2026-11-01"),
      note: "backlog cleared 2026-11-25, not individually checked",
    },
  ]);
  expect(onClose).toHaveBeenCalledOnce();
});
