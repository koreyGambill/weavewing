import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { revisionedQuery } from "../../state/revisionedQuery";
import { serverEnvironment } from "../../state/server";
import { apiKeyThreadCost, isApiKeyInstance, type ThreadApiCost } from "./threadCost.logic";

/**
 * The thread's API-key spend, or null when its provider is not billed by API key. `settledAt`
 * changes when a turn's usage settles and refetches; undefined (mid-turn) keeps the last answer.
 */
export function useThreadApiCost(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settledAt: string | null | undefined;
}): ThreadApiCost | null {
  const enabled =
    input.threadId !== null && isApiKeyInstance(input.providers, input.providerInstanceId);
  const query = useEnvironmentQuery(
    enabled && input.threadId !== null
      ? revisionedQuery(
          serverEnvironment.threadCost({
            environmentId: input.environmentId,
            input: { threadId: input.threadId },
          }),
          input.settledAt,
        )
      : null,
  );
  return query.data === null ? null : apiKeyThreadCost(query.data, input.providers);
}
