import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export interface HandoffWorktreeDialogRequest {
  readonly threadRef: ScopedThreadRef;
  /** The control that opened the dialog, which gets focus back when it closes. */
  readonly returnFocus: HTMLElement | null;
  /** Distinguishes each opening, so a reopened dialog starts with a fresh form. */
  readonly sequence: number;
}

/**
 * The latest request stays after the dialog closes, so the dialog can run its closing
 * transition and hand focus back to the control that opened it.
 */
export const handoffWorktreeDialogAtom = Atom.make<{
  readonly request: HandoffWorktreeDialogRequest | null;
  readonly open: boolean;
}>({ request: null, open: false }).pipe(Atom.keepAlive);

export function openHandoffWorktree(threadRef: ScopedThreadRef, returnFocus: HTMLElement | null) {
  const sequence = (appAtomRegistry.get(handoffWorktreeDialogAtom).request?.sequence ?? 0) + 1;
  appAtomRegistry.set(handoffWorktreeDialogAtom, {
    request: { threadRef, returnFocus, sequence },
    open: true,
  });
}

export function closeHandoffWorktree() {
  const { request } = appAtomRegistry.get(handoffWorktreeDialogAtom);
  appAtomRegistry.set(handoffWorktreeDialogAtom, { request, open: false });
}
