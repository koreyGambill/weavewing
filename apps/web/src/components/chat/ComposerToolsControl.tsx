import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  ClaudeSettings,
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ThreadMcpServer,
  ThreadToolOverrides,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { WrenchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { ComposerControl } from "./ComposerControl";
import {
  claudeSettingsForInstance,
  connectorsMasterDecides,
  mcpServerSections,
  withConnectorsMaster,
  withMcpServerSwitched,
  type McpServerRow,
  EMPTY_TOOL_OVERRIDES,
  formatTokenEstimate,
  isRowOn,
  threadTurnRunning,
  toolRows,
  toolsFooterState,
  toolsLabel,
  withRowSwitched,
  type ToolRow,
  type ToolsFooterState,
} from "./ComposerToolsControl.logic";

/** The thread fields the control reads; all of them are already on the thread shell. */
export interface ComposerToolsThread {
  readonly id: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly toolOverrides?: ThreadToolOverrides | undefined;
  readonly runtime: { readonly status: string } | null;
  readonly pendingBackgroundTasks: ReadonlyArray<unknown>;
}

/** One item a composer row can host, shown inline or folded into the row's overflow menu. */
export interface ComposerRowItem {
  readonly id: string;
  readonly priority: number;
  readonly hidden: boolean;
  readonly renderRowItem: () => ReactNode;
  readonly renderMenuRow: () => ReactNode;
}

const TOOLS_ROW_ITEM_PRIORITY = 40;

/** The per-thread tools item for the composer row; hidden for threads not on Claude. */
export function useComposerToolsRowItem(
  environmentId: EnvironmentId,
  thread: ComposerToolsThread,
): ComposerRowItem {
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadToolOverrides === true;
  const provider = supported
    ? claudeSettingsForInstance({ providerInstances }, thread.providerInstanceId)
    : null;
  const label = toolsLabel(provider, thread.toolOverrides);
  const render = (presentation: "row" | "menu") =>
    provider === null ? null : (
      <ComposerToolsControl
        environmentId={environmentId}
        thread={thread}
        provider={provider}
        presentation={presentation}
      />
    );
  return {
    id: "thread-tools",
    priority: TOOLS_ROW_ITEM_PRIORITY,
    hidden: label.hidden,
    renderRowItem: () => render("row"),
    renderMenuRow: () => render("menu"),
  };
}

export function ComposerToolsControl({
  environmentId,
  thread,
  provider,
  presentation,
}: {
  environmentId: EnvironmentId;
  thread: ComposerToolsThread;
  provider: Pick<ClaudeSettings, "omittedBuiltinTools" | "claudeAiConnectors">;
  presentation: "row" | "menu";
}) {
  const [open, setOpen] = useState(false);
  // Staged switches outlive a closed popover, so stopping a turn does not lose them.
  const [staged, setStaged] = useState<{
    readonly threadId: ThreadId;
    readonly value: ThreadToolOverrides;
  } | null>(null);
  const saved = thread.toolOverrides ?? EMPTY_TOOL_OVERRIDES;
  const stagedValue = staged?.threadId === thread.id ? staged.value : saved;
  const label = toolsLabel(provider, thread.toolOverrides);
  const trigger =
    presentation === "row" ? (
      <ComposerControl size="xs" aria-label={`${label.text}. Change tools for this thread`} />
    ) : (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`${label.text}. Change tools for this thread`}
      />
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} data-thread-tools-trigger="">
        <WrenchIcon aria-hidden="true" />
        <span>
          <span className="font-medium text-foreground">Tools</span>{" "}
          {label.onCount === 0
            ? `${label.offCount} off`
            : `${label.onCount} on · ${label.offCount} off`}
        </span>
      </PopoverTrigger>
      {open ? (
        <PopoverPopup
          side="top"
          align="start"
          width="lg"
          padding="none"
          aria-label="Tools left out of this thread"
        >
          <ToolsPopoverContent
            environmentId={environmentId}
            thread={thread}
            provider={provider}
            saved={saved}
            staged={stagedValue}
            onStage={(value) => setStaged({ threadId: thread.id, value })}
            onApplied={() => {
              setStaged(null);
              setOpen(false);
            }}
          />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}

function ToolsPopoverContent({
  environmentId,
  thread,
  provider,
  saved,
  staged,
  onStage,
  onApplied,
}: {
  environmentId: EnvironmentId;
  thread: ComposerToolsThread;
  provider: Pick<ClaudeSettings, "omittedBuiltinTools" | "claudeAiConnectors">;
  saved: ThreadToolOverrides;
  staged: ThreadToolOverrides;
  onStage: (value: ThreadToolOverrides) => void;
  onApplied: () => void;
}) {
  // Read only while open, so a closed control costs no permission lookups.
  const permitted = useAtomValue(
    orchestrationEnvironment.setThreadToolOverrides.permissionAtom(environmentId),
  );
  const setToolOverrides = useAtomCommand(orchestrationEnvironment.setThreadToolOverrides, {
    reportFailure: false,
  });
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Rows come from what is saved, so switching one off keeps it listed until it is applied.
  const rows = toolRows(provider, saved);
  const footer = toolsFooterState({
    rows,
    saved,
    staged,
    turnRunning: threadTurnRunning(thread.runtime?.status),
    backgroundWork: thread.pendingBackgroundTasks.length > 0,
  });
  const reload = async () => {
    setSending(true);
    setFailure(null);
    const result = await setToolOverrides({
      environmentId,
      input: { threadId: thread.id, toolOverrides: staged },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      setFailure(error instanceof Error ? error.message : "Could not reload the session.");
      return;
    }
    toastManager.add(reloadToast(result.value.outcome));
    onApplied();
  };
  return (
    <div className="flex flex-col">
      <header className="border-b px-3 pt-2.5 pb-2">
        <h2 className="font-semibold text-sm">Tools left out of this thread</h2>
        <p className="text-muted-foreground text-xs">
          Switch one on for this thread only. Token figures are estimates of the context each adds.
        </p>
      </header>
      <ul className="divide-y" aria-label="Built-in tools">
        {rows
          .filter((row) => row.key !== "claudeAiConnectors")
          .map((row) => (
            <ToolSwitchRow
              key={row.key}
              row={row}
              on={isRowOn(row, staged)}
              onChange={(on) => onStage(withRowSwitched(staged, row.key, on))}
            />
          ))}
      </ul>
      <McpServersSection
        environmentId={environmentId}
        threadId={thread.id}
        provider={provider}
        connectorsRow={rows.find((row) => row.key === "claudeAiConnectors")}
        saved={saved}
        staged={staged}
        onStage={onStage}
      />
      <ToolsFooter
        state={footer}
        permitted={permitted}
        sending={sending}
        failure={failure}
        onReload={() => void reload()}
      />
    </div>
  );
}

function McpServersSection({
  environmentId,
  threadId,
  provider,
  connectorsRow,
  saved,
  staged,
  onStage,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  provider: Pick<ClaudeSettings, "claudeAiConnectors">;
  connectorsRow: ToolRow | undefined;
  saved: ThreadToolOverrides;
  staged: ThreadToolOverrides;
  onStage: (value: ThreadToolOverrides) => void;
}) {
  // Mounted only while the popover is open; closing it or switching threads drops the request.
  const inventoryAtom = orchestrationEnvironment.threadMcpServers({
    environmentId,
    input: { threadId },
  });
  const inventory = useAtomValue(inventoryAtom);
  const retry = useAtomRefresh(inventoryAtom);
  const servers = AsyncResult.isSuccess(inventory) ? inventory.value.servers : [];
  const connectorNames = servers.filter((server) => server.connector).map((server) => server.name);
  const masterDecides = connectorsMasterDecides(provider, saved);
  const sections = mcpServerSections({ inventory: servers, provider, saved, staged });
  const switchServer = (server: ThreadMcpServer, on: boolean) =>
    onStage(withMcpServerSwitched({ staged, server, on, connectorNames, masterDecides }));
  return (
    <section className="border-t" aria-label="MCP servers">
      <h3 className="px-3 pt-2 pb-1 font-medium text-muted-foreground text-xs">MCP servers</h3>
      {AsyncResult.isFailure(inventory) ? (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs">
          <p className="min-w-0 flex-1 text-destructive-foreground">
            Could not list this thread's MCP servers.
          </p>
          <Button size="xs" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : AsyncResult.isSuccess(inventory) ? null : (
        <p className="px-3 pb-2 text-muted-foreground text-xs">Loading MCP servers…</p>
      )}
      <ul className="divide-y" aria-label="MCP servers">
        {sections.servers.map((row) => (
          <McpServerSwitchRow
            key={row.name}
            row={row}
            onChange={(on) => switchServer({ name: row.name, connector: false, status: "" }, on)}
          />
        ))}
        {connectorsRow === undefined && sections.connectors.length === 0 ? null : (
          <li>
            {connectorsRow === undefined ? (
              <p className="px-3 py-2 text-sm">
                <span className="font-medium">claude.ai connectors</span>{" "}
                <span className="text-muted-foreground text-xs">left to Claude Code</span>
              </p>
            ) : (
              <ToolSwitchRow
                row={connectorsRow}
                on={staged.claudeAiConnectors}
                onChange={(on) => onStage(withConnectorsMaster(staged, on, connectorNames))}
                asListItem={false}
              />
            )}
            {sections.connectors.length === 0 ? null : (
              <ul aria-label="claude.ai connectors" className="pb-1">
                {sections.connectors.map((row) => (
                  <McpServerSwitchRow
                    key={row.name}
                    row={row}
                    nested
                    onChange={(on) =>
                      switchServer({ name: row.name, connector: true, status: "" }, on)
                    }
                  />
                ))}
              </ul>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}

function McpServerSwitchRow({
  row,
  nested = false,
  onChange,
}: {
  row: McpServerRow;
  nested?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li>
      <label
        className={cn(
          "grid cursor-pointer grid-cols-[auto_1fr] items-center gap-2.5 py-1.5 pr-3 hover:bg-accent/50",
          nested ? "pl-9" : "pl-3",
        )}
      >
        <Switch size="sm" checked={row.on} onCheckedChange={onChange} />
        <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{row.name}</span>
      </label>
    </li>
  );
}

function ToolSwitchRow({
  row,
  on,
  onChange,
  asListItem = true,
}: {
  row: ToolRow;
  on: boolean;
  onChange: (on: boolean) => void;
  asListItem?: boolean;
}) {
  const content = (
    <label className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-start gap-2.5 px-3 py-2 hover:bg-accent/50">
      <Switch size="sm" className="mt-0.5" checked={on} onCheckedChange={onChange} />
      <span className="min-w-0">
        <span className="block font-medium text-sm">{row.label}</span>
        <span className="block text-muted-foreground text-xs">{row.description}</span>
      </span>
      <span className="pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">
        ~{formatTokenEstimate(row.estimatedTokens)}
      </span>
    </label>
  );
  return asListItem ? <li>{content}</li> : content;
}

function ToolsFooter({
  state,
  permitted,
  sending,
  failure,
  onReload,
}: {
  state: ToolsFooterState;
  permitted: boolean;
  sending: boolean;
  failure: string | null;
  onReload: () => void;
}) {
  const blocked = state.kind === "running" || state.kind === "background";
  return (
    <footer className="flex items-center gap-3 border-t bg-card px-3 py-2.5">
      <div className="min-w-0 flex-1 text-xs" aria-live="polite">
        {state.kind === "running" ? (
          <p className="text-warning-foreground">
            A turn is running. Stop it or wait for it to finish, then reload. Your switches are
            kept.
          </p>
        ) : state.kind === "background" ? (
          <p className="text-warning-foreground">
            This session is running background agents or commands that a reload would end. Wait for
            them, or press Stop.
          </p>
        ) : state.kind === "unchanged" ? (
          <>
            <p>Nothing changed</p>
            <p className="text-muted-foreground">
              Reload anyway to pick up changed settings, skills or MCP servers.
            </p>
          </>
        ) : (
          <>
            <p>{changedSummary(state)}</p>
            <p className="text-muted-foreground">
              Reloading keeps the conversation. The next message re-reads it once without the cache.
            </p>
          </>
        )}
        {permitted ? null : (
          <p className="text-muted-foreground">Your access can't change this thread's tools.</p>
        )}
        {failure === null ? null : <p className="text-destructive-foreground">{failure}</p>}
      </div>
      <Button
        size="xs"
        variant={state.kind === "unchanged" ? "outline" : "default"}
        disabled={blocked || sending || !permitted}
        onClick={onReload}
      >
        {sending ? "Reloading…" : "Reload session"}
      </Button>
    </footer>
  );
}

function changedSummary(state: Extract<ToolsFooterState, { readonly kind: "changed" }>): string {
  const parts = [
    ...(state.onCount === 0 ? [] : [`${state.onCount} switched on`]),
    ...(state.serversLeftOut === 0
      ? []
      : [
          `${state.serversLeftOut} MCP ${state.serversLeftOut === 1 ? "server" : "servers"} left out`,
        ]),
  ];
  if (parts.length === 0) return "Nothing switched on";
  return state.estimatedTokens === 0
    ? parts.join(", ")
    : `${parts.join(", ")}, about +${formatTokenEstimate(state.estimatedTokens)} tokens`;
}

function reloadToast(outcome: "stored" | "reloaded" | "reload-failed") {
  switch (outcome) {
    case "stored":
      return {
        type: "success" as const,
        title: "Tools saved",
        description: "They apply when this thread's session next starts.",
      };
    case "reloaded":
      return { type: "success" as const, title: "Session reloaded" };
    case "reload-failed":
      return {
        type: "error" as const,
        title: "The old session may still be running",
        description: "Tools are saved. Reload the session again, or press Stop.",
      };
  }
}
