import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type StatusSource,
  type StatusItem,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  BellOffIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironments } from "../../state/environments";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironmentsWithScope } from "../../state/session";
import { statusSources, statusSourcesSnooze } from "../../state/statusSources";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { RelativeTime } from "../RelativeTime";
import { StatusStateIcon, StatusSourceIcon } from "./StatusSourceIcon";
import { createStatusSourceNotificationGate } from "./statusSourceNotifications.logic";
import { summarizeStatusSources } from "./statusSourceSummary.logic";
import {
  groupStatusItems,
  isStatusItemDisabled,
  sourceExpanded,
  sourceExpansionState,
  type SourceExpansion,
  statusItemCounts,
} from "./statusSources.logic";

const sourcesAtom = environmentAtomList("web-status-sources", (environmentId) =>
  statusSources({ environmentId, input: {} }),
);

/** The worst status-source state across connected environments, and their sources. */
export function useStatusSignal() {
  const groups = useStatusSourceGroups();
  const state = summarizeStatusSources(
    groups.flatMap((group) => group.sources ?? []),
    groups.some((group) => group.failed || group.sources === null),
  );
  return { state, groups };
}

export function useStatusSourceGroups() {
  const { environments } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.statusSources === true &&
      readable.has(environment.environmentId),
  );
  const queries = useAtomValue(
    sourcesAtom(environmentIdsKey(connected.map((entry) => entry.environmentId))),
  );
  return connected.map((environment, index) => ({
    environment,
    sources: AsyncResult.getOrElse(queries[index]!, () => null),
    failed: AsyncResult.isFailure(queries[index]!),
  }));
}

function presentTransition(source: StatusSource, environmentId: EnvironmentId) {
  const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
  const recovered = source.latest.state === "ok";
  const title = `${source.config.name} · ${recovered ? "Recovered" : source.latest.state === "fail" ? "Failed" : "Warning"}`;
  const looking = document.visibilityState === "visible" && document.hasFocus();
  if (looking && inAppNotificationsEnabled) {
    toastManager.add({
      type: recovered ? "success" : source.latest.state === "fail" ? "error" : "warning",
      title,
      description: source.latest.summary,
      data: { hideCopyButton: true },
    });
  } else if (
    !looking &&
    hasDesktopNotifications(notificationMode) &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      const notification = new Notification(title, {
        body: source.latest.summary,
        tag: `status-source:${environmentId}:${source.config.id}`,
        silent: true,
      });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
      });
    } catch {
      // Browsers may expose Notification while refusing desktop presentation.
    }
  }
  if (hasNotificationSound(notificationMode)) {
    void playNotificationSound(recovered ? "completion" : "input", () =>
      hasNotificationSound(getClientSettings().notificationMode),
    );
  }
}

function EnvironmentNotifications({
  environmentId,
  sources,
}: {
  environmentId: EnvironmentId;
  sources: ReadonlyArray<StatusSource> | null;
}) {
  const [gate] = useState(createStatusSourceNotificationGate);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes external notifications when server-owned source transitions arrive
  useEffect(() => {
    if (sources)
      for (const source of gate.observe(sources, Date.now()))
        presentTransition(source, environmentId);
  }, [environmentId, gate, sources]);
  return null;
}

export function StatusSourceNotifications() {
  return useStatusSourceGroups().map(({ environment, sources }) => (
    <EnvironmentNotifications
      key={environment.environmentId}
      environmentId={environment.environmentId}
      sources={sources}
    />
  ));
}

function toolUrl(value: string | undefined): string | undefined {
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

function StatusHint({ children, text }: { children: ReactElement; text: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{text}</TooltipPopup>
    </Tooltip>
  );
}

function StatusCheck({ item }: { item: StatusItem }) {
  const [expanded, setExpanded] = useState(false);
  const url = toolUrl(item.url);
  const attention = item.state === "fail" || item.state === "warn";
  return (
    <li className="text-xs">
      <div className="flex min-w-0 items-center gap-1">
        <StatusHint
          text={`${item.name} · ${isStatusItemDisabled(item) ? "disabled" : item.state}${item.detail ? `: ${item.detail}` : ""}`}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <StatusStateIcon state={item.state} disabled={isStatusItemDisabled(item)} />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
          </button>
        </StatusHint>
        {url && (
          <Button
            variant="ghost"
            size="icon-xs"
            render={
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${item.name}`}
              />
            }
          >
            <ExternalLinkIcon />
          </Button>
        )}
      </div>
      {item.detail && (expanded || attention) && (
        <p
          className={
            expanded
              ? "px-1 pb-1 text-muted-foreground wrap-anywhere"
              : "truncate px-1 pb-1 text-muted-foreground"
          }
        >
          {item.detail}
        </p>
      )}
    </li>
  );
}

function SourceStatus({
  source,
  environmentId,
}: {
  source: StatusSource;
  environmentId: EnvironmentId;
}) {
  const now = useNowMinute();
  const snoozed = source.config.snoozedUntil !== null && source.config.snoozedUntil > now;
  const permission = useAtomValue(statusSourcesSnooze.permissionAtom(environmentId));
  const snooze = useAtomCommand(statusSourcesSnooze, { reportFailure: true });
  const [busy, setBusy] = useState(false);
  const storageKey = `status-source-expanded:${environmentId}:${source.config.id}`;
  const [expansion, setExpansion] = useState<SourceExpansion | null>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return typeof parsed?.expanded === "boolean" &&
        ["fail", "warn", "ok", "unknown"].includes(parsed.state)
        ? {
            expanded: parsed.expanded,
            state: parsed.state,
            ...(typeof parsed.at === "string" ? { at: parsed.at } : {}),
          }
        : null;
    } catch {
      return null;
    }
  });
  const expanded = sourceExpanded(source.latest, expansion, source.lastTransition?.at);
  const [inactiveExpanded, setInactiveExpanded] = useState(false);
  const { active, inactive } = groupStatusItems(source.latest.items);
  const toggleExpanded = () => {
    const next = {
      expanded: !expanded,
      state: sourceExpansionState(source.latest),
      // Server time, so a client with a skewed clock compares like with like; "" sorts before any transition.
      at: source.lastTransition?.at ?? "",
    };
    setExpansion(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Storage can be unavailable in private browsers. */
    }
  };
  const handleSnooze = async (until: string | null) => {
    setBusy(true);
    await snooze({ environmentId, input: { id: source.config.id, until } });
    setBusy(false);
  };
  const url = toolUrl(source.latest.url);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <li className="border-t border-border py-1 text-xs">
      <div className="flex min-w-0 items-center gap-0.5">
        <StatusHint
          text={
            <>
              {source.config.name}: {source.latest.summary}
              {statusItemCounts(source.latest.items) &&
                ` · ${statusItemCounts(source.latest.items)}`}
              {source.lastTransition && (
                <span className="block">
                  {source.lastTransition.from}→{source.lastTransition.to} ·{" "}
                  <RelativeTime timestamp={source.lastTransition.at} />
                </span>
              )}
            </>
          }
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 rounded py-1 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            aria-expanded={expanded}
            aria-label={`${source.config.name}: ${source.latest.state}${statusItemCounts(source.latest.items) ? ` · ${statusItemCounts(source.latest.items)}` : ""}`}
            onClick={toggleExpanded}
          >
            <Chevron className="size-3 shrink-0" />
            <StatusSourceIcon source={source} />
            <span className="min-w-0 flex-1 truncate font-medium">{source.config.name}</span>
            <StatusStateIcon state={source.latest.state} />
            <span className="max-w-16 truncate text-3xs text-muted-foreground">
              {statusItemCounts(source.latest.items)}
            </span>
            {source.lastTransition && source.latest.items.length === 0 && (
              <span className="max-w-24 truncate text-3xs text-muted-foreground">
                {source.lastTransition.from}→{source.lastTransition.to}{" "}
                <RelativeTime timestamp={source.lastTransition.at} />
              </span>
            )}
          </button>
        </StatusHint>
        {url && (
          <Button
            variant="ghost"
            size="icon-xs"
            render={
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${source.config.name} tool`}
              />
            }
          >
            <ExternalLinkIcon />
          </Button>
        )}
        {snoozed && (
          <StatusHint
            text={`Notifications snoozed until ${new Date(source.config.snoozedUntil!).toLocaleString()}`}
          >
            <BellOffIcon
              role="img"
              aria-label={`Notifications snoozed until ${new Date(source.config.snoozedUntil!).toLocaleString()}`}
              className="size-3 shrink-0 text-muted-foreground"
            />
          </StatusHint>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${source.config.name} actions`}
                disabled={!permission || busy}
              />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup>
            {snoozed ? (
              <MenuItem onClick={() => void handleSnooze(null)}>Unsnooze notifications</MenuItem>
            ) : (
              [15, 60, 1440].map((minutes) => (
                <MenuItem
                  key={minutes}
                  onClick={() =>
                    void handleSnooze(new Date(Date.now() + minutes * 60_000).toISOString())
                  }
                >
                  Snooze {minutes === 1440 ? "1 day" : minutes === 60 ? "1 hour" : "15 minutes"}
                </MenuItem>
              ))
            )}
          </MenuPopup>
        </Menu>
      </div>
      {expanded && (
        <div className="pl-5">
          {active.length === 0 && inactive.length === 0 && (
            <p className="py-1 text-muted-foreground wrap-anywhere">{source.latest.summary}</p>
          )}
          {active.length > 0 && (
            <ul>
              {active.map((item) => (
                <StatusCheck key={item.name} item={item} />
              ))}
            </ul>
          )}
          {source.lastTransition && (
            <p className="py-1 text-muted-foreground">
              {source.lastTransition.from}→{source.lastTransition.to} ·{" "}
              <RelativeTime timestamp={source.lastTransition.at} />
            </p>
          )}
          {inactive.length > 0 && (
            <>
              <button
                type="button"
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-muted-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                aria-expanded={inactiveExpanded}
                onClick={() => setInactiveExpanded(!inactiveExpanded)}
              >
                {inactiveExpanded ? (
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
                {inactive.length} disabled
              </button>
              {inactiveExpanded && (
                <ul>
                  {inactive.map((item) => (
                    <StatusCheck key={item.name} item={item} />
                  ))}
                </ul>
              )}
            </>
          )}
          {snoozed && (
            <p className="py-1 text-muted-foreground">
              Notifications snoozed until {new Date(source.config.snoozedUntil!).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function StatusSourcesList({
  groups,
  onConfigureSources,
}: {
  groups: ReturnType<typeof useStatusSourceGroups>;
  onConfigureSources: (environmentId: EnvironmentId) => void;
}) {
  return groups.map(({ environment, sources, failed }) => (
    <section
      key={environment.environmentId}
      className="px-2 py-1"
      aria-label={`${environment.label} status sources`}
    >
      <div className="flex min-w-0 items-center gap-1 py-0.5">
        <h3 className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate">{environment.label}</span>
          {!failed && sources?.length === 0 && <span className="shrink-0">· no sources</span>}
        </h3>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Configure status sources for ${environment.label}`}
          onClick={() => onConfigureSources(environment.environmentId)}
        >
          <SettingsIcon />
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="py-2 text-xs text-muted-foreground">
          Could not load status sources.
        </p>
      ) : sources === null ? (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          Loading sources…
        </p>
      ) : (
        <ul>
          {sources.map((source) => (
            <SourceStatus
              key={source.config.id}
              source={source}
              environmentId={environment.environmentId}
            />
          ))}
        </ul>
      )}
    </section>
  ));
}
