import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";

/** The deadline is measured from the limit report, which can survive failed probes. */
export function sidebarLimitReading(limits: ServerProviderUsageLimits) {
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt) || limitsNotice(limits) !== null) return null;

  const window =
    limits.windows.find(
      (window) =>
        window.kind === "weekly" && !window.modelIds?.length && !window.providerIds?.length,
    ) ??
    limits.windows.find((window) => window.kind === "weekly") ??
    limits.windows[0];
  return window ? { window, deadline: checkedAt + 60 * 60 * 1_000 } : null;
}
