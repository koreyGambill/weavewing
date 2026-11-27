import { threadAnswerToolSession } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { canTrackAnswer } from "./trackedAnswers-availability.logic";

export function useCanTrackAnswerTarget(
  threadRef: ScopedThreadRef | null,
  draft?: { readonly environmentId: EnvironmentId; readonly instanceId: ProviderInstanceId | null },
) {
  const shell = useQuietThreadShell(threadRef);
  const detail = useQuietThreadProjection(threadRef);
  const providers = useEnvironmentProviders();
  const environmentId = draft?.environmentId ?? threadRef?.environmentId;
  if (environmentId === undefined) return false;
  const instanceId = draft?.instanceId ?? shell?.modelSelection.instanceId;
  const provider = providers.get(environmentId)?.find((entry) => entry.instanceId === instanceId);
  const thread = detail?.projection.thread;
  return canTrackAnswer(
    provider,
    threadAnswerToolSession(detail?.projection),
    shell?.delegatedFrom != null || thread?.lineage.relationshipToParent === "subagent",
  );
}
