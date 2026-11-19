import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";

const refreshArms = Atom.make<ReadonlyMap<string, symbol>>(new Map()).pipe(Atom.keepAlive);

export function readSideChatRefreshArm(threadKey: string): symbol | undefined {
  return appAtomRegistry.get(refreshArms).get(threadKey);
}

export function toggleSideChatRefresh(threadKey: string): void {
  const next = new Map(appAtomRegistry.get(refreshArms));
  if (!next.delete(threadKey)) next.set(threadKey, Symbol());
  appAtomRegistry.set(refreshArms, next);
}

export function consumeSideChatRefresh(threadKey: string, arm: symbol): void {
  if (readSideChatRefreshArm(threadKey) !== arm) return;
  toggleSideChatRefresh(threadKey);
}

export function useSideChatRefreshArmed(threadKey: string): boolean {
  return useAtomValue(refreshArms).has(threadKey);
}
