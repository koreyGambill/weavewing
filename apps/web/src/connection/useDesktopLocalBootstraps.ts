import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

// Failed reads retain the last good snapshot; unchanged polls notify no one.
const desktopLocalBootstrapsAtom = Atom.make((get) => {
  const interval = setInterval(
    () => get.setSelf(readDesktopSecondaryBootstraps()),
    DESKTOP_LOCAL_BOOTSTRAP_POLL_MS,
  );
  const unsubscribe = window.desktopBridge?.onLocalEnvironmentReady?.(() =>
    get.setSelf(readDesktopSecondaryBootstraps()),
  );
  get.addFinalizer(() => {
    clearInterval(interval);
    unsubscribe?.();
  });
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
