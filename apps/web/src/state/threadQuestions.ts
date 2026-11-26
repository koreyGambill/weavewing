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
import { useAtomCommand } from "./use-atom-command";
import { serverEnvironment } from "./server";
import { useEnvironmentScope } from "./session";
import { threadWorkspaceGet } from "./threadWorkspace";

/** Environments that show waiting-on-you cards; one atom for every sidebar row to share. */
export const waitingCardsEnvironmentIdsAtom = Atom.make((get) => {
  const next = get(environmentSummaries.environmentIdsAtom).filter(
    (environmentId) => get(serverEnvironment.settingsValueAtom(environmentId))?.waitingCardsEnabled,
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

/**
 * Saves one question's draft through the thread's draft writer; null when the save failed or
 * there is no thread.
 */
export function useSaveQuestionDraft(threadRef: ScopedThreadRef | null) {
  const saveDraft = useAtomCommand(threadQuestionDraft);
  return async (
    id: string,
    draft: { readonly chosenOptionIds: ReadonlyArray<string>; readonly notes: string },
  ) => {
    if (threadRef === null) return null;
    const result = await saveDraft({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        answers: { [id]: { chosenOptionIds: [...draft.chosenOptionIds], notes: draft.notes } },
      },
    });
    return result._tag === "Success" ? result.value : null;
  };
}

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
