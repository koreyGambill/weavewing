import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type StatusSource,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
import { StatusSourceDot, StatusSourceIcon } from "./StatusSourceIcon";
import { createStatusSourceNotificationGate } from "./statusSourceNotifications.logic";
import { summarizeStatusSources } from "./statusSourceSummary.logic";

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
  const handleSnooze = async (until: string | null) => {
    setBusy(true);
    await snooze({
      environmentId,
      input: {
        id: source.config.id,
        until,
      },
    });
    setBusy(false);
  };
  const url = toolUrl(source.latest.url);
  return (
    <li className="space-y-2 border-t border-border py-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <StatusSourceIcon source={source} />
        <span className="min-w-0 flex-1 wrap-anywhere font-medium">{source.config.name}</span>
        <StatusSourceDot state={source.latest.state} />
        <span className="text-xs text-muted-foreground">{source.latest.state}</span>
      </div>
      <p className="wrap-anywhere text-muted-foreground">{source.latest.summary}</p>
      {source.lastTransition && (
        <p className="text-xs text-muted-foreground">
          {source.lastTransition.from} → {source.lastTransition.to} ·{" "}
          <Tooltip>
            <TooltipTrigger render={<time dateTime={source.lastTransition.at} tabIndex={0} />}>
              <RelativeTime timestamp={source.lastTransition.at} />
            </TooltipTrigger>
            <TooltipPopup>{new Date(source.lastTransition.at).toLocaleString()}</TooltipPopup>
          </Tooltip>
        </p>
      )}
      {source.latest.items.length > 0 && (
        <ul className="space-y-2 pl-2">
          {source.latest.items.map((item) => (
            <li key={item.name} className="flex items-start gap-2 text-xs">
              <span className="pt-1">
                <StatusSourceDot state={item.state} />
              </span>
              <div className="min-w-0 flex-1 wrap-anywhere">
                <span>
                  {item.name} · {item.state}
                </span>
                {item.detail && <p className="text-muted-foreground">{item.detail}</p>}
              </div>
              {toolUrl(item.url) && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  render={
                    <a
                      href={toolUrl(item.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${item.name}`}
                    />
                  }
                >
                  <ExternalLinkIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {snoozed && (
        <p className="text-xs text-muted-foreground">
          Notifications snoozed until {new Date(source.config.snoozedUntil!).toLocaleString()}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {url && (
          <Button
            variant="ghost"
            size="xs"
            render={<a href={url} target="_blank" rel="noopener noreferrer" />}
          >
            Open tool <ExternalLinkIcon />
          </Button>
        )}
        {snoozed ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={!permission || busy}
            onClick={() => void handleSnooze(null)}
          >
            Unsnooze
          </Button>
        ) : (
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="xs" disabled={!permission || busy} />}
            >
              Snooze…
            </MenuTrigger>
            <MenuPopup>
              {[15, 60, 1440].map((minutes) => (
                <MenuItem
                  key={minutes}
                  onClick={() =>
                    void handleSnooze(new Date(Date.now() + minutes * 60_000).toISOString())
                  }
                >
                  {minutes === 1440 ? "1 day" : minutes === 60 ? "1 hour" : "15 minutes"}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
      </div>
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
      className="px-3 py-2"
      aria-label={`${environment.label} status sources`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 py-1">
        <h3 className="min-w-0 wrap-anywhere text-xs text-muted-foreground">{environment.label}</h3>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onConfigureSources(environment.environmentId)}
        >
          Configure sources
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="py-2 text-sm text-muted-foreground">
          Could not load status sources.
        </p>
      ) : sources === null ? (
        <p role="status" className="py-2 text-sm text-muted-foreground">
          Loading sources…
        </p>
      ) : sources.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No status sources configured.</p>
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
