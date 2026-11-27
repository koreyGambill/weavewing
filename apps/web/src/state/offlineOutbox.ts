import { createOfflineOutbox, type OfflineSubmission } from "@t3tools/client-runtime/state/threads";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "@t3tools/client-runtime/rpc";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { CommandId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";
import { threadEnvironment } from "./threads";
import {
  clearSentTrackedAnswer,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../composerDraftStore";

export const offlineOutbox = createOfflineOutbox();
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);
const drafts = new Map<
  CommandId,
  {
    target: ComposerThreadTarget;
    snapshot: ReturnType<ReturnType<typeof useComposerDraftStore.getState>["getComposerDraft"]>;
  }
>();

export function enqueueOfflineSubmission(
  submission: OfflineSubmission,
  target: ComposerThreadTarget,
) {
  drafts.set(submission.input.commandId, {
    target,
    snapshot: useComposerDraftStore.getState().getComposerDraft(target),
  });
  if (offlineOutbox.enqueue(submission)) return true;
  drafts.delete(submission.input.commandId);
  return false;
}

const connectionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => ({
    state: AsyncResult.getOrElse(get(environmentCatalog.stateAtom(environmentId)), () => null),
    generation: get(environmentCatalog.sessionGenerationAtom(environmentId)),
    prepared: Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(environmentId))),
  })),
);

const send = async (submission: OfflineSubmission) => {
  const result = await threadEnvironment.startTurn.run(appAtomRegistry, {
    environmentId: submission.environmentId,
    input: { ...submission.input, expectedEnvironmentId: submission.serverId },
  });
  if (result._tag === "Success") {
    const draft = drafts.get(submission.input.commandId);
    const store = useComposerDraftStore.getState();
    if (draft && store.getComposerDraft(draft.target) === draft.snapshot)
      store.clearComposerContent(draft.target, { retainTrackedAnswer: true });
    const sentContext = submission.input.message.context;
    if (
      draft?.snapshot?.trackedAnswer &&
      (sentContext?.trackedAsk || sentContext?.discussAnswers?.length)
    ) {
      clearSentTrackedAnswer(draft.target, draft.snapshot.trackedAnswer);
    }
    return "sent" as const;
  }
  const error = squashAtomCommandFailure(result);
  if (isRpcClientError(error) || isEnvironmentRpcUnavailableError(error)) {
    return "disconnected" as const;
  }
  return {
    error: error instanceof Error ? error.message : "The server refused the queued message.",
  };
};

const subscriptions = new Map<EnvironmentId, () => void>();
offlineOutbox.subscribe(() => {
  const commands = new Set(offlineOutbox.getSnapshot().map((entry) => entry.input.commandId));
  for (const id of drafts.keys()) if (!commands.has(id)) drafts.delete(id);
  const pending = new Set(offlineOutbox.getSnapshot().map((entry) => entry.environmentId));
  for (const [environmentId, unsubscribe] of subscriptions) {
    if (pending.has(environmentId)) continue;
    unsubscribe();
    subscriptions.delete(environmentId);
  }
  for (const environmentId of pending) {
    if (subscriptions.has(environmentId)) continue;
    const onConnection = ({
      state,
      prepared,
      generation,
    }: Atom.Type<ReturnType<typeof connectionAtom>>) => {
      if (state?.phase !== "connected" || prepared === null) return;
      void offlineOutbox.reconnect(environmentId, prepared.environmentId, generation, send);
    };
    const unsubscribe = appAtomRegistry.subscribe(connectionAtom(environmentId), onConnection);
    subscriptions.set(environmentId, unsubscribe);
    onConnection(appAtomRegistry.get(connectionAtom(environmentId)));
  }
});

export function useOfflineOutbox() {
  return useSyncExternalStore(offlineOutbox.subscribe, offlineOutbox.getSnapshot);
}
