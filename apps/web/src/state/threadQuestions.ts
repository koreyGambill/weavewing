import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSummaries } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useEnvironmentScope } from "./session";
import { threadWorkspaceGet } from "./threadWorkspace";

/** Environments whose agents may ask questions; one atom for every sidebar row to share. */
export const agentQuestionsEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) =>
      get(serverEnvironment.settingsValueAtom(environmentId))?.agentQuestionsEnabled,
  );
  const previous = get.self<ReadonlyArray<EnvironmentId>>();
  return previous._tag === "Some" &&
    previous.value.length === next.length &&
    previous.value.every((id, index) => id === next[index])
    ? previous.value
    : next;
});

// The latest workspace a question command returned, so a choice shows before the query refetches.
const returnedWorkspaceAtom = Atom.family((_threadKey: string) =>
  Atom.make<ThreadWorkspace | null>(null),
);
const threadKey = (environmentId: EnvironmentId, threadId: string) =>
  `${environmentId}:${threadId}`;

const remember = (
  target: { readonly environmentId: EnvironmentId; readonly input: { readonly threadId: string } },
  registry: AtomRegistry.AtomRegistry,
  workspace: ThreadWorkspace,
) =>
  Effect.sync(() =>
    registry.set(
      returnedWorkspaceAtom(threadKey(target.environmentId, target.input.threadId)),
      workspace,
    ),
  );

export const threadQuestionUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "question:update",
  tag: WS_METHODS.threadQuestionUpdate,
  onSuccess: remember,
});
export const threadQuestionDraft = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "question:draft",
  tag: WS_METHODS.threadQuestionDraft,
  onSuccess: remember,
});
export const threadQuestionSubmit = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "question:submit",
  tag: WS_METHODS.threadQuestionSubmit,
  onSuccess: remember,
});

/**
 * The thread's questions from its workspace. Every reader shares one query; a null thread or
 * `enabled` false reads nothing, as for a thread that has never had a question.
 */
export function useThreadQuestionsWorkspace(threadRef: ScopedThreadRef | null, enabled: boolean) {
  const canRead = useEnvironmentScope(threadRef?.environmentId ?? null, AuthOrchestrationReadScope);
  const active = enabled && canRead && threadRef !== null;
  const query = useEnvironmentQuery(
    active
      ? threadWorkspaceGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const returned = useAtomValue(
    returnedWorkspaceAtom(
      threadRef === null ? "" : threadKey(threadRef.environmentId, threadRef.threadId),
    ),
  );
  const workspace =
    returned !== null && returned.revision > (query.data?.revision ?? -1) ? returned : query.data;
  return { workspace: active ? workspace : null, refresh: query.refresh, error: query.error };
}
