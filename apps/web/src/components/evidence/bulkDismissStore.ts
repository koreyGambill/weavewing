import { EVIDENCE_BULK_DISMISS_DEFAULT_REASON, type EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { localDateInputValue } from "./bulkDismiss.logic";

interface BulkDismissDraft {
  readonly day: string;
  readonly reason: string;
}

/**
 * The bulk dismissal being chosen, per environment, kept outside the Evidence view so a narrow
 * window that unmounts the view keeps the day and reason; the dialog shows again with the view,
 * and only in the environment it was opened for.
 */
export const useBulkDismissStore = create<{
  /** The environment whose dismissal is open, if any. */
  readonly openFor: EnvironmentId | null;
  readonly drafts: Readonly<Record<EnvironmentId, BulkDismissDraft>>;
  readonly start: (environmentId: EnvironmentId) => void;
  readonly close: () => void;
  readonly edit: (environmentId: EnvironmentId, change: Partial<BulkDismissDraft>) => void;
}>()((set) => ({
  openFor: null,
  drafts: {},
  start: (environmentId) =>
    set((state) => ({
      openFor: environmentId,
      drafts: {
        ...state.drafts,
        [environmentId]: {
          day: localDateInputValue(new Date()),
          reason: EVIDENCE_BULK_DISMISS_DEFAULT_REASON,
        },
      },
    })),
  close: () => set({ openFor: null }),
  edit: (environmentId, change) =>
    set((state) => {
      const draft = state.drafts[environmentId];
      return draft === undefined
        ? state
        : { drafts: { ...state.drafts, [environmentId]: { ...draft, ...change } } };
    }),
}));

type BulkDismissState = ReturnType<typeof useBulkDismissStore.getState>;

/** The open dismissal's draft for `environmentId`, or null when none is open there. */
export const bulkDismissDraftFor = (
  state: Pick<BulkDismissState, "openFor" | "drafts">,
  environmentId: EnvironmentId | null,
): BulkDismissDraft | null =>
  environmentId !== null && state.openFor === environmentId
    ? (state.drafts[environmentId] ?? null)
    : null;

export const useBulkDismissDraft = (environmentId: EnvironmentId | null) =>
  useBulkDismissStore((state) => bulkDismissDraftFor(state, environmentId));
