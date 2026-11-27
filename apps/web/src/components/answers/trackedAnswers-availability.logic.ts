import type { OrchestrationV2ProviderSession, ServerProvider } from "@t3tools/contracts";

type AnswerToolSession = Pick<
  OrchestrationV2ProviderSession,
  "providerInstanceId" | "trackedAnswersAvailable"
>;
type AnswerToolProvider = Pick<ServerProvider, "instanceId" | "supportsTrackedAnswers">;

export function canTrackAnswer(
  provider: AnswerToolProvider | undefined,
  session: AnswerToolSession | null | undefined,
  delegated: boolean,
): boolean {
  if (!provider || delegated) return false;
  const live =
    session?.providerInstanceId === provider.instanceId
      ? session.trackedAnswersAvailable
      : undefined;
  return live ?? provider.supportsTrackedAnswers === true;
}
