import type { ProviderInstanceId, ServerProvider, ThreadCost } from "@t3tools/contracts";

export interface ThreadApiCost {
  /** Main agent at list price, plus the subagent and compaction estimate. Null when no model has a rate. */
  readonly costUsd: number | null;
  readonly tokens: number;
  readonly unpricedTokens: number;
  readonly otherTokens: number;
  /** Some of the thread ran on an instance that is not billed by API key, and is left out. */
  readonly excludesOtherInstances: boolean;
}

export function isApiKeyInstance(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "auth">>,
  instanceId: ProviderInstanceId | null,
): boolean {
  return (
    instanceId !== null &&
    providers.some(
      (provider) => provider.instanceId === instanceId && provider.auth.type === "apiKey",
    )
  );
}

/** The thread's cost on API-key instances only, or null before any of them used tokens. */
export function apiKeyThreadCost(
  cost: ThreadCost,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "auth">>,
): ThreadApiCost | null {
  let costUsd = 0;
  let tokens = 0;
  let unpricedTokens = 0;
  let otherTokens = 0;
  let priced = false;
  let excludesOtherInstances = false;
  for (const entry of cost.instances) {
    if (!isApiKeyInstance(providers, entry.providerInstanceId)) {
      excludesOtherInstances = true;
      continue;
    }
    tokens += entry.tokens;
    unpricedTokens += entry.unpricedTokens;
    otherTokens += entry.otherTokens;
    if (entry.costUsd !== null) {
      priced = true;
      costUsd += entry.costUsd;
    }
    if (entry.otherCostUsdEstimate !== null) {
      priced = true;
      costUsd += entry.otherCostUsdEstimate;
    }
  }
  if (tokens + otherTokens === 0) return null;
  return {
    costUsd: priced ? costUsd : null,
    tokens,
    unpricedTokens,
    otherTokens,
    excludesOtherInstances,
  };
}
