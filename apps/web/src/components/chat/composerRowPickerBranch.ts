import { Atom } from "effect/reactivity";

/**
 * The ref the composer row's branch picker shows for a thread, keyed by scoped thread key, so the
 * row's pull request chip can tell when the picker shows a ref the thread has not recorded yet.
 * Undefined while no row picker shows one.
 */
export const composerRowPickerBranchAtom = Atom.family((threadKey: string) =>
  Atom.make<string | null | undefined>(undefined).pipe(
    Atom.keepAlive,
    Atom.withLabel(`composer-row-picker-branch:${threadKey}`),
  ),
);
