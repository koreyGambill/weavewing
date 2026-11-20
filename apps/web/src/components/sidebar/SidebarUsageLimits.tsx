import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  limitsNotice,
  remainingPercent,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import { CircleAlertIcon, ClockIcon } from "lucide-react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { useNowMinute } from "../../hooks/useNowMinute";
import { environmentPresentations } from "../../state/presentation";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LimitWindows } from "../usage/UsageLimits";
import { accountInitials } from "../usage/usageProviders";
import { sidebarLimitReading } from "../usage/sidebarUsageLimits.logic";

function SubscriptionDetails({
  account,
  name,
  expired,
}: {
  readonly account: LimitAccount;
  readonly name: string;
  readonly expired: boolean;
}) {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const { limits } = account;
  const notice = limitsNotice(limits);
  const credits = limits.resetCredits?.availableCount;
  const sources = [account.sourceLabel, ...account.environments.map(({ label }) => label)].filter(
    Boolean,
  );
  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1.5">
        <PopoverTitle>{name} usage limits</PopoverTitle>
        {account.plan || sources.length ? (
          <p className="text-xs text-muted-foreground">
            {[account.plan, ...sources].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </header>
      {expired ? (
        <p className="text-xs text-warning-foreground">
          Showing the last reported limits. They may be out of date.
        </p>
      ) : null}
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      {limits.windows.length ? (
        <LimitWindows
          driver={account.driver}
          accentColor={account.accentColor}
          windows={limits.windows}
          now={now}
          compact
        />
      ) : null}
      {credits !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {credits} reset {credits === 1 ? "credit" : "credits"} available
        </p>
      ) : null}
    </div>
  );
}

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
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label={`${name}: ${status}`} />}
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
      <PopoverPopup side="top" align="start" width="md">
        <SubscriptionDetails account={account} name={name} expired={expired} />
      </PopoverPopup>
    </Popover>
  );
}

/** Show each subscription once, using the same grouping as Usage → Limits. */
export function SidebarUsageLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const accounts = collectLimitAccounts(presentations, {
    includeUnavailable: true,
    preferWindowObservation: true,
  });
  if (accounts.length === 0) return null;

  return (
    <div className="ms-1 flex min-w-6 flex-wrap items-center">
      {accounts.map((account) => (
        <SubscriptionIndicator key={account.key} account={account} />
      ))}
    </div>
  );
}
