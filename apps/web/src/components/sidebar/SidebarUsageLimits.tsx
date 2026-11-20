import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  remainingPercent,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import { CircleAlertIcon, ClockIcon } from "lucide-react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { environmentPresentations } from "../../state/presentation";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { accountInitials } from "../usage/usageProviders";
import { sidebarLimitReading } from "../usage/sidebarUsageLimits.logic";

function SubscriptionIndicator({ account }: { readonly account: LimitAccount }) {
  const reading = sidebarLimitReading(account.limits);
  const expired = useDeadlinePassed(reading?.deadline ?? null);
  const provider =
    account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver;
  const name = account.email ? `${provider} (${accountInitials(account.email)})` : provider;
  const remaining = reading && !expired ? remainingPercent(reading.window) : null;
  const status = expired
    ? "Usage out of date"
    : remaining === null
      ? "Usage unavailable"
      : `${reading?.window.label} · ${remaining}% left`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${name}: ${status}`}
            tabIndex={0}
            className="inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded-md text-sidebar-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {remaining === null ? (
          expired ? (
            <ClockIcon className="size-3.5" aria-hidden />
          ) : (
            <CircleAlertIcon className="size-3.5" aria-hidden />
          )
        ) : (
          <span
            aria-hidden
            className="size-3.5 rounded-full [mask:radial-gradient(farthest-side,transparent_calc(100%_-_1.5px),black_calc(100%_-_1px))]"
            style={{
              background: `conic-gradient(currentColor ${remaining}%, var(--color-muted) 0)`,
            }}
          />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {name} · {status}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Show each subscription once, using the same grouping as Usage → Limits. */
export function SidebarUsageLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const accounts = collectLimitAccounts(presentations, { includeUnavailable: true });
  if (accounts.length === 0) return null;

  return (
    <div className="ms-1 flex min-w-6 flex-wrap items-center">
      {accounts.map((account) => (
        <SubscriptionIndicator key={account.key} account={account} />
      ))}
    </div>
  );
}
