import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useEnvironmentScope } from "./session";

export interface QuestionThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const threadWorkspaceGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:thread-questions:workspace",
  tag: WS_METHODS.threadWorkspaceGet,
  staleTimeMs: 2_000,
  idleTtlMs: 0,
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
  label: "mobile:question:update",
  tag: WS_METHODS.threadQuestionUpdate,
  onSuccess: remember,
});
export const threadQuestionDraft = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:question:draft",
  tag: WS_METHODS.threadQuestionDraft,
  onSuccess: remember,
});

/** Null while the environment's settings load, so only a setting known to be off reads false. */
export function useWaitingCardsEnabled(environmentId: EnvironmentId): boolean | null {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return settings === null || settings === undefined ? null : settings.waitingCardsEnabled;
}

/**
 * The thread's questions from its workspace, newest of the query and the last command reply.
 * Reads nothing while waiting cards are off or the connection cannot read the thread.
 */
export function useThreadQuestionsWorkspace(threadRef: QuestionThreadRef) {
  const enabled = useWaitingCardsEnabled(threadRef.environmentId) === true;
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const active = enabled && canRead;
  const query = useEnvironmentQuery(
    active
      ? threadWorkspaceGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const returned = useAtomValue(
    returnedWorkspaceAtom(threadKey(threadRef.environmentId, threadRef.threadId)),
  );
  const workspace =
    returned !== null && returned.revision > (query.data?.revision ?? -1) ? returned : query.data;
  return { workspace: active ? workspace : null, refresh: query.refresh, error: query.error };
}
