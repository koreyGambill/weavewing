import { WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { subtreeRunSignal } from "../components/threadTimeline.logic";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";

export const threadInsightsGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadInsights:get",
  tag: WS_METHODS.threadInsightsGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const threadContextGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadInsights:context",
  tag: WS_METHODS.threadContextGet,
  staleTimeMs: 30_000,
  idleTtlMs: 0,
});

export const threadDefaultContextGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadInsights:defaultContext",
  tag: WS_METHODS.threadDefaultContextGet,
  staleTimeMs: 30_000,
  idleTtlMs: 0,
});

export const threadDefaultContextItem = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadInsights:defaultContextItem",
  tag: WS_METHODS.threadDefaultContextItem,
  staleTimeMs: 30_000,
  idleTtlMs: 0,
});

const timelineSignalAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) =>
    subtreeRunSignal(threadId, get(environmentThreadShells.environmentThreadsAtom(environmentId))),
  ).pipe(Atom.withLabel(`threadInsights:timeline-signal:${key}`));
});

export const threadTimelineGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadInsights:timeline",
  tag: WS_METHODS.threadTimelineGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId, input }) =>
    timelineSignalAtom(JSON.stringify([environmentId, input.threadId])),
});

const userTurnSignalAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
    return shell?.latestUserAuthoredMessageAt ?? shell?.latestUserMessageAt ?? null;
  }).pipe(Atom.withLabel(`threadInsights:user-turn-signal:${key}`));
});

/** The turn rail's own turns beyond the loaded window; refetched only when the user sends one. */
export const threadUserTurnsGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadInsights:userTurns",
  tag: WS_METHODS.threadUserTurnsGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
  refreshTrigger: ({ environmentId, input }) =>
    userTurnSignalAtom(JSON.stringify([environmentId, input.threadId])),
});
