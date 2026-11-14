import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { resolveEnvironmentMachineKind, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { BotIcon, Clock3Icon, GitBranchIcon } from "lucide-react";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { ThreadGlyph } from "../ThreadGlyph";
import { isThreadGlyphWorking } from "../Sidebar.logic";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { useWorkspaceNavigation, type WorkspaceVisit } from "./workspaceNavigation";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

export function useWorkspaceVisit(threadRef: ScopedThreadRef | null, title: string) {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records route visits from every entry point in recent thread history
  useEffect(() => {
    if (environmentId && threadId)
      useWorkspaceNavigation.getState().visit({ ref: { environmentId, threadId }, title });
  }, [environmentId, threadId, title]);
}

export function WorkspaceHistoryButton() {
  const navigate = useNavigate();
  const [historyOpen, setHistoryOpen] = useState(false);
  const recent = useWorkspaceNavigation((state) => state.recent);
  const open = (ref: ScopedThreadRef) => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  return (
    <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
      <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
        <PopoverTrigger
          render={
            <Button size="icon-sm" variant="ghost-muted" aria-label="Recent Threads">
              <Clock3Icon className="size-4" />
            </Button>
          }
        />
        <PopoverPopup side="bottom" align="start" className="w-[min(36rem,calc(100vw-1rem))]">
          <h2 className="mb-1 border-b border-border px-2 py-2 text-center text-xs font-medium">
            Recent Threads
          </h2>
          <div className="max-h-80 overflow-y-auto">
            {recent.map((visit) => (
              <HistoryThreadRow
                key={`${visit.ref.environmentId}:${visit.ref.threadId}`}
                visit={visit}
                onSelect={() => {
                  setHistoryOpen(false);
                  open(visit.ref);
                }}
              />
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

function HistoryThreadRow({
  visit,
  onSelect,
}: {
  readonly visit: WorkspaceVisit;
  readonly onSelect: () => void;
}) {
  const thread = useQuietThreadShell(visit.ref);
  const project = useProject(
    thread ? scopeProjectRef(visit.ref.environmentId, thread.projectId) : null,
  );
  const environment = useEnvironment(visit.ref.environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(visit.ref.environmentId));
  const entries = deriveProviderInstanceEntries(providers ?? []);
  const configured = environment?.serverConfig
    ? applyProviderInstanceSettings(entries, environment.serverConfig.settings, null)
    : entries;
  const instanceId = thread?.runtime?.providerInstanceId ?? thread?.modelSelection.instanceId;
  const provider = configured.find((entry) => entry.instanceId === instanceId);
  const title = thread?.title ?? visit.title;
  const machine = environment?.label ?? "Unavailable computer";
  const providerLabel =
    provider?.displayName ?? thread?.runtime?.providerName ?? instanceId ?? "AI";
  const details = [
    title,
    project?.title,
    thread?.branch,
    machine,
    providerLabel,
    thread?.modelSelection.model,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-muted"
            aria-label={title}
            onClick={onSelect}
          />
        }
      >
        <ThreadGlyph
          threadId={visit.ref.threadId}
          seed={thread?.glyphSeed}
          working={thread ? isThreadGlyphWorking(thread) : false}
          className="size-4"
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {project && (
          <span className="hidden max-w-24 shrink truncate text-2xs text-muted-foreground sm:inline">
            {project.title}
          </span>
        )}
        {thread?.branch && (
          <span className="hidden min-w-0 max-w-24 shrink items-center gap-1 text-2xs text-muted-foreground sm:inline-flex">
            <GitBranchIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{thread.branch}</span>
          </span>
        )}
        {thread && <HistoryTime timestamp={thread.latestUserMessageAt ?? thread.updatedAt} />}
        <span className="flex shrink-0 items-center text-muted-foreground">
          <EnvironmentMachineIcon
            role="img"
            aria-label={machine}
            kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
            className="size-3.5"
          />
        </span>
        <span className="flex shrink-0 items-center" aria-label={providerLabel}>
          {provider ? (
            <ProviderInstanceIcon
              driverKind={provider.driverKind}
              displayName={provider.displayName}
              accentColor={provider.accentColor}
              acpRegistryAgentId={provider.acpRegistryAgentId}
              acpRegistryIconUrl={provider.acpRegistryIconUrl}
              size="compact"
            />
          ) : (
            <BotIcon aria-label={providerLabel} className="size-3.5 text-muted-foreground" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipPopup>{details}</TooltipPopup>
    </Tooltip>
  );
}

function HistoryTime({ timestamp }: { readonly timestamp: string }) {
  const minute = useNowMinute();
  return (
    <time dateTime={timestamp} className="shrink-0 text-2xs tabular-nums text-muted-foreground">
      {formatRelativeTimeLabel(timestamp, Date.parse(`${minute}:00.000Z`))}
    </time>
  );
}
