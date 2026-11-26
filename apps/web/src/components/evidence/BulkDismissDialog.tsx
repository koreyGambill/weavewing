import { EVIDENCE_BULK_DISMISS_DEFAULT_REASON, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { evidenceBulkSetQa } from "../../state/evidence";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { bulkDismissBefore, localDateInputValue } from "./bulkDismiss.logic";

const changes = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;

/**
 * Dismisses, as the user, every change in this environment still waiting for QA that landed
 * before a chosen day, with one reason. It shows how many that is before anything changes.
 */
export function BulkDismissDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const [day, setDay] = useState(() => localDateInputValue(new Date()));
  const [reason, setReason] = useState(EVIDENCE_BULK_DISMISS_DEFAULT_REASON);
  const [count, setCount] = useState<{ readonly day: string; readonly count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const bulkSetQa = useAtomCommand(evidenceBulkSetQa, { label: "Dismiss pending QA" });
  const countFor = useAtomCommand(evidenceBulkSetQa, { reportFailure: false });
  const before = bulkDismissBefore(day);
  const requestCount = useEffectEvent((at: string) =>
    countFor({ environmentId, input: { before: at, dryRun: true } }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server how many changes the chosen day covers, so the count shows before the user confirms
  useEffect(() => {
    if (before === null) return;
    let current = true;
    void requestCount(before).then((result) => {
      if (current && result._tag === "Success") setCount({ day, count: result.value.count });
    });
    return () => {
      current = false;
    };
  }, [before, day]);
  const shown = count !== null && count.day === day ? count.count : null;
  const note = reason.trim();
  const usable = before !== null && note !== "" && shown !== null && shown > 0 && !busy;
  const confirm = async () => {
    if (!usable) return;
    setBusy(true);
    const result = await bulkSetQa({ environmentId, input: { before, note } });
    setBusy(false);
    if (result._tag !== "Success") return;
    toastManager.add({
      type: "success",
      title: `Dismissed ${changes(result.value.count)}`,
      description: "Each keeps your reason and can be reopened from its card.",
    });
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss pending QA</DialogTitle>
          <DialogDescription>
            Closes every change in every thread that still waits for your QA and landed before the
            day you pick. Changes you are discussing and problems the agent is fixing stay.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="bulk-dismiss"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-dismiss-day">Landed before</Label>
              <Input
                id="bulk-dismiss-day"
                type="date"
                required
                value={day}
                onChange={(event) => setDay(event.currentTarget.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bulk-dismiss-reason">Reason</Label>
              <Textarea
                id="bulk-dismiss-reason"
                required
                value={reason}
                aria-invalid={note === ""}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
              {note === "" ? (
                <p className="text-xs text-destructive-foreground">Say why they are dismissed.</p>
              ) : null}
            </div>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {before === null
                ? "Pick a day."
                : shown === null
                  ? "Counting…"
                  : shown === 0
                    ? "Nothing waits for QA from before that day."
                    : `${changes(shown)} will be dismissed.`}
            </p>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="bulk-dismiss" variant="destructive" disabled={!usable}>
            {shown === null || shown === 0 ? "Dismiss" : `Dismiss ${changes(shown)}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
