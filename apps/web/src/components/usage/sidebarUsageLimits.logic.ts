import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { subscriptionLimitReading } from "@t3tools/shared/usageLimits";

/** A sidebar reading expires one hour after its selected window was observed. */
export function sidebarLimitReading(limits: ServerProviderUsageLimits) {
  const reading = subscriptionLimitReading(limits);
  return reading
    ? { window: reading.window, deadline: reading.observedAt + 60 * 60 * 1_000 }
    : null;
}
