import type { EnvironmentId, EvidenceChangeKey } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
import { bulkDismissBefore } from "./bulkDismiss.logic";
import { useBulkDismissStore } from "./bulkDismissStore";

const changes = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;

type Preview =
  | {
      readonly day: string;
      readonly status: "ready";
      readonly changes: ReadonlyArray<EvidenceChangeKey>;
      readonly more: boolean;
    }
  | { readonly day: string; readonly status: "failed" };

/**
 * Dismisses, as the user, the changes in this environment still waiting for QA that landed
 * before a chosen day, with one reason. It lists them first, and the dismissal acts only on that
 * list, so a change that starts waiting meanwhile is left for the next one.
 */
export function BulkDismissDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const { day, reason, setDay, setReason } = useBulkDismissStore();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const bulkSetQa = useAtomCommand(evidenceBulkSetQa, { label: "Dismiss pending QA" });
  const list = useAtomCommand(evidenceBulkSetQa, { reportFailure: false });
  const before = bulkDismissBefore(day);
  // What the day covers, as the dialog shows it.
  const load = async (at: string, forDay: string): Promise<Preview> => {
    const result = await list({
      environmentId,
      input: { before: DateTime.makeUnsafe(at), dryRun: true },
    });
    return result._tag === "Success"
      ? {
          day: forDay,
          status: "ready",
          changes: result.value.changes ?? [],
          more: result.value.more === true,
        }
      : { day: forDay, status: "failed" };
  };
  const loadFor = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server which changes the chosen day covers, so the user sees them counted before confirming
  useEffect(() => {
    if (before === null) return;
    let current = true;
    void loadFor(before, day).then((next) => {
      if (current) setPreview(next);
    });
    return () => {
      current = false;
    };
  }, [before, day]);
  const shown = preview !== null && preview.day === day ? preview : null;
  const listed = shown?.status === "ready" ? shown.changes : null;
  const note = reason.trim();
  const usable = before !== null && note !== "" && listed !== null && listed.length > 0 && !busy;
  const confirm = async () => {
    if (!usable) return;
    setBusy(true);
    const result = await bulkSetQa({
      environmentId,
      input: { before: DateTime.makeUnsafe(before), note, changes: [...listed] },
    });
    setBusy(false);
    if (result._tag !== "Success") return;
    const skipped = listed.length - result.value.count;
    toastManager.add({
      type: "success",
      title: `Dismissed ${changes(result.value.count)}`,
      description:
        skipped > 0
          ? `${changes(skipped)} had changed since they were counted and stayed open.`
          : "Each keeps your reason and can be reopened from its card.",
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
            <div
              aria-live="polite"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              {before === null ? (
                "Pick a day."
              ) : shown === null ? (
                "Counting…"
              ) : shown.status === "failed" ? (
                <>
                  <span>The count did not load.</span>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      if (before === null) return;
                      setPreview(null);
                      void load(before, day).then((next) => {
                        // A day picked meanwhile has its own count on the way.
                        if (useBulkDismissStore.getState().day === day) setPreview(next);
                      });
                    }}
                  >
                    Retry
                  </Button>
                </>
              ) : shown.changes.length === 0 ? (
                "Nothing waits for QA from before that day."
              ) : shown.more ? (
                `The oldest ${changes(shown.changes.length)} will be dismissed; run it again for the rest.`
              ) : (
                `${changes(shown.changes.length)} will be dismissed.`
              )}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="bulk-dismiss" variant="destructive" disabled={!usable}>
            {listed === null || listed.length === 0
              ? "Dismiss"
              : `Dismiss ${changes(listed.length)}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
