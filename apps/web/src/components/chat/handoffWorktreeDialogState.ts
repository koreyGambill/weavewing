import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export const handoffWorktreeDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
);

export function openHandoffWorktree(threadRef: ScopedThreadRef) {
  appAtomRegistry.set(handoffWorktreeDialogAtom, threadRef);
}

export function closeHandoffWorktree() {
  appAtomRegistry.set(handoffWorktreeDialogAtom, null);
}
