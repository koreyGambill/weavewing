import { EVIDENCE_BULK_DISMISS_DEFAULT_REASON } from "@t3tools/contracts";
import { create } from "zustand";

import { localDateInputValue } from "./bulkDismiss.logic";

/**
 * The bulk dismissal being chosen, kept outside the Evidence view so a narrow window that
 * unmounts the view keeps the day and reason; the dialog shows again with the view.
 */
export const useBulkDismissStore = create<{
  readonly open: boolean;
  readonly day: string;
  readonly reason: string;
  readonly start: () => void;
  readonly close: () => void;
  readonly setDay: (day: string) => void;
  readonly setReason: (reason: string) => void;
}>()((set) => ({
  open: false,
  day: "",
  reason: "",
  start: () =>
    set({
      open: true,
      day: localDateInputValue(new Date()),
      reason: EVIDENCE_BULK_DISMISS_DEFAULT_REASON,
    }),
  close: () => set({ open: false }),
  setDay: (day) => set({ day }),
  setReason: (reason) => set({ reason }),
}));
