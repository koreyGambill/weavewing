import { ProviderInstanceId, type ThreadCostEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { apiKeyThreadCost } from "./threadCost.logic";

const providers = [
  {
    instanceId: ProviderInstanceId.make("claudeApi"),
    auth: { status: "authenticated", type: "apiKey" },
  },
  {
    instanceId: ProviderInstanceId.make("codex"),
    auth: { status: "authenticated", type: "chatgpt" },
  },
] as const;

const entry = (instance: string, overrides: Partial<ThreadCostEntry> = {}): ThreadCostEntry => ({
  providerInstanceId: ProviderInstanceId.make(instance),
  tokens: 100,
  costUsd: 1,
  unpricedTokens: 0,
  otherTokens: 0,
  otherCostUsdEstimate: null,
  ...overrides,
});

describe("apiKeyThreadCost", () => {
  it("counts only API-key instances and adds the subagent estimate", () => {
    expect(
      apiKeyThreadCost(
        {
          instances: [
            entry("claudeApi", { otherTokens: 50, otherCostUsdEstimate: 0.5 }),
            entry("codex", { costUsd: 9 }),
          ],
        },
        providers,
      ),
    ).toEqual({
      costUsd: 1.5,
      tokens: 100,
      unpricedTokens: 0,
      otherTokens: 50,
      excludesOtherInstances: true,
    });
  });

  it("keeps an unpriced API-key thread visible without a price", () => {
    expect(
      apiKeyThreadCost(
        { instances: [entry("claudeApi", { costUsd: null, unpricedTokens: 100 })] },
        providers,
      )?.costUsd,
    ).toBeNull();
  });

  it("has nothing to show without API-key usage", () => {
    expect(apiKeyThreadCost({ instances: [entry("codex")] }, providers)).toBeNull();
  });
});
