import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { canTrackAnswer } from "./trackedAnswers-availability.logic";

it("uses the matching session's tool availability and excludes delegated children", () => {
  const instanceId = ProviderInstanceId.make("instance");
  const provider = { instanceId, supportsTrackedAnswers: true };
  expect(canTrackAnswer(provider, null, false)).toBe(true);
  expect(canTrackAnswer(provider, null, true)).toBe(false);
  expect(canTrackAnswer({ instanceId, supportsTrackedAnswers: false }, null, false)).toBe(false);
  expect(
    canTrackAnswer(
      provider,
      { providerInstanceId: instanceId, trackedAnswersAvailable: false },
      false,
    ),
  ).toBe(false);
  expect(
    canTrackAnswer(
      { instanceId },
      { providerInstanceId: instanceId, trackedAnswersAvailable: true },
      false,
    ),
  ).toBe(true);
  expect(
    canTrackAnswer(
      { instanceId },
      { providerInstanceId: ProviderInstanceId.make("other"), trackedAnswersAvailable: true },
      false,
    ),
  ).toBe(false);
});
