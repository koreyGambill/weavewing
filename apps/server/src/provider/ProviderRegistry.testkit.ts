import { ProviderDriverKind } from "@t3tools/contracts";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

export const adapterWithoutCapabilityReport = {
  getCapabilities: () =>
    Effect.fail(
      new ProviderAdapterProtocolError({
        driver: ProviderDriverKind.make("test-provider"),
        detail: "No provider capability response.",
      }),
    ),
} as unknown as ProviderInstance["orchestrationAdapter"];
