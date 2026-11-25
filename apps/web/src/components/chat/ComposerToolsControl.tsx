import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS,
  type ClaudeSettings,
  type EnvironmentId,
  type ThreadId,
  type ProviderInstanceId,
  type ThreadToolOverrides,
  type OrchestrationV2ListThreadMcpServersResult,
  threadToolOverridesNotice,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
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
  connectorsMode,
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

const NO_INVENTORY_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<OrchestrationV2ListThreadMcpServersResult, unknown>
> = Atom.make(AsyncResult.initial<OrchestrationV2ListThreadMcpServersResult, unknown>()).pipe(
  Atom.withLabel("thread-tools:no-inventory"),
);

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
          {label.text.slice("Tools ".length)}
        </span>
      </PopoverTrigger>
      {open ? (
        <PopoverPopup
          side="top"
          align="start"
          width="lg"
          padding="none"
          aria-label="Tools for this thread"
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
  const [failure, setFailure] = useState<string | null>(null);
  const canList = useAtomValue(
    orchestrationEnvironment.threadMcpServers.permissionAtom(environmentId),
  );
  // Mounted only while the popover is open; closing it or switching threads drops the request.
  const inventoryAtom = canList
    ? orchestrationEnvironment.threadMcpServers({ environmentId, input: { threadId: thread.id } })
    : NO_INVENTORY_ATOM;
  const inventory = useAtomValue(inventoryAtom);
  const retryInventory = useAtomRefresh(inventoryAtom);
  const servers = AsyncResult.isSuccess(inventory) ? inventory.value.servers : [];
  const rows = toolRows(provider);
  const footer = toolsFooterState({
    rows,
    saved,
    staged,
    ordinaryServerNames: servers.filter((server) => !server.connector).map((server) => server.name),
    turnRunning: threadTurnRunning(thread.runtime?.status),
    backgroundWork: thread.pendingBackgroundTasks.length > 0,
  });
  const [sending, setSending] = useState(false);
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
    toastManager.add({ type: "success", title: threadToolOverridesNotice(staged) });
    onApplied();
  };
  return (
    <div className="flex flex-col">
      <header className="border-b px-3 pt-2.5 pb-2">
        <h2 className="font-semibold text-sm">Tools for this thread</h2>
        <p className="text-muted-foreground text-xs">
          Switch a left-out tool on, or a server off, for this thread only. Token figures are
          estimates of the context each adds.
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground text-xs">
          No built-in tools are left out for this provider.
        </p>
      ) : (
        <ul className="divide-y" aria-label="Built-in tools">
          {rows.map((row) => (
            <ToolSwitchRow
              key={row.key}
              label={row.label}
              description={row.description}
              estimatedTokens={row.estimatedTokens}
              on={isRowOn(row, staged)}
              onChange={(on) => onStage(withRowSwitched(staged, row.key, on))}
            />
          ))}
        </ul>
      )}
      <McpServersSection
        canList={canList}
        inventory={inventory}
        onRetry={retryInventory}
        provider={provider}
        staged={staged}
        onStage={onStage}
      />
      <ToolsFooter
        state={footer}
        permitted={permitted}
        failure={failure}
        sending={sending}
        onReload={() => void reload()}
      />
    </div>
  );
}

function McpServersSection({
  canList,
  inventory,
  onRetry,
  provider,
  staged,
  onStage,
}: {
  canList: boolean;
  inventory: AsyncResult.AsyncResult<OrchestrationV2ListThreadMcpServersResult, unknown>;
  onRetry: () => void;
  provider: Pick<ClaudeSettings, "claudeAiConnectors">;
  staged: ThreadToolOverrides;
  onStage: (value: ThreadToolOverrides) => void;
}) {
  const servers = AsyncResult.isSuccess(inventory) ? inventory.value.servers : [];
  const connectorNames = servers.filter((server) => server.connector).map((server) => server.name);
  const sections = mcpServerSections({ inventory: servers, provider, staged });
  return (
    <section className="border-t" aria-label="MCP servers">
      <h3 className="px-3 pt-2 font-medium text-muted-foreground text-xs">MCP servers</h3>
      <p className="px-3 pb-1 text-muted-foreground text-xs">
        Off keeps a server's tools out of the model's context; the server may still connect.
      </p>
      {!canList ? (
        <p className="px-3 pb-2 text-muted-foreground text-xs">
          Your access can't list this thread's MCP servers.
        </p>
      ) : AsyncResult.isFailure(inventory) ? (
        <div className="flex items-center gap-2 px-3 pb-2 text-xs">
          <p className="min-w-0 flex-1 text-destructive-foreground">
            Could not list this thread's MCP servers.
          </p>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : AsyncResult.isSuccess(inventory) ? null : (
        <p className="px-3 pb-2 text-muted-foreground text-xs">Loading MCP servers…</p>
      )}
      {sections.servers.length === 0 ? null : (
        <ul className="divide-y" aria-label="MCP servers">
          {sections.servers.map((row) => (
            <McpServerSwitchRow
              key={row.name}
              row={row}
              onChange={(on) => onStage(withMcpServerSwitched(staged, row.name, on))}
            />
          ))}
        </ul>
      )}
      <ConnectorsMaster
        provider={provider}
        staged={staged}
        onStage={onStage}
        connectorNames={connectorNames}
      />
      {sections.connectors.length === 0 ? null : (
        <ul aria-label="claude.ai connectors" className="pb-1">
          {sections.connectors.map((row) => (
            <McpServerSwitchRow
              key={row.name}
              row={row}
              nested
              onChange={(on) =>
                onStage(
                  withMcpServerSwitched(
                    staged,
                    row.name,
                    on,
                    connectorsMode(provider) === "switch" ? connectorNames : [],
                  ),
                )
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectorsMaster({
  provider,
  staged,
  onStage,
  connectorNames,
}: {
  provider: Pick<ClaudeSettings, "claudeAiConnectors">;
  staged: ThreadToolOverrides;
  onStage: (value: ThreadToolOverrides) => void;
  connectorNames: ReadonlyArray<string>;
}) {
  const setOn = (on: boolean) => onStage(withConnectorsMaster(staged, on, connectorNames));
  if (connectorsMode(provider) === "switch") {
    return (
      <div className="border-t">
        <ToolSwitchRow
          label="claude.ai connectors"
          description="Every connector on your Claude account"
          estimatedTokens={CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS}
          on={staged.claudeAiConnectors}
          onChange={setOn}
          asListItem={false}
        />
      </div>
    );
  }
  // Claude Code decides here, so the unforced state is never shown as off.
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-2.5 border-t px-3 py-2">
      <span className="min-w-0">
        <span className="block font-medium text-sm">claude.ai connectors</span>
        <span className="block text-muted-foreground text-xs">
          {staged.claudeAiConnectors
            ? `On for this thread, about ${formatTokenEstimate(CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS)} tokens (estimate)`
            : "Left to Claude Code"}
        </span>
      </span>
      <Button size="xs" variant="outline" onClick={() => setOn(!staged.claudeAiConnectors)}>
        {staged.claudeAiConnectors ? "Leave to Claude Code" : "Turn on for this thread"}
      </Button>
    </div>
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
  const name = (
    <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
      {row.name}
      {row.active ? null : (
        <span className="text-muted-foreground text-xs"> · not loaded in this session</span>
      )}
    </span>
  );
  const padding = nested ? "pl-9" : "pl-3";
  if (!row.switchable) {
    return (
      <li className={cn("grid grid-cols-[1fr] py-1.5 pr-3 text-muted-foreground", padding)}>
        {name}
      </li>
    );
  }
  return (
    <li>
      <label
        className={cn(
          "grid cursor-pointer grid-cols-[auto_1fr] items-center gap-2.5 py-1.5 pr-3 hover:bg-accent/50",
          padding,
        )}
      >
        <Switch size="sm" checked={row.on} onCheckedChange={onChange} />
        {name}
      </label>
    </li>
  );
}

function ToolSwitchRow({
  label,
  description,
  estimatedTokens,
  on,
  onChange,
  asListItem = true,
}: {
  label: string;
  description: string;
  estimatedTokens: number;
  on: boolean;
  onChange: (on: boolean) => void;
  asListItem?: boolean;
}) {
  const content = (
    <label className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-start gap-2.5 px-3 py-2 hover:bg-accent/50">
      <Switch size="sm" className="mt-0.5" checked={on} onCheckedChange={onChange} />
      <span className="min-w-0">
        <span className="block font-medium text-sm">{label}</span>
        <span className="block text-muted-foreground text-xs">{description}</span>
      </span>
      <span className="pt-0.5 font-mono text-muted-foreground text-xs tabular-nums">
        ~{formatTokenEstimate(estimatedTokens)}
      </span>
    </label>
  );
  return asListItem ? <li>{content}</li> : content;
}

function ToolsFooter({
  state,
  permitted,
  failure,
  sending,
  onReload,
}: {
  state: ToolsFooterState;
  permitted: boolean;
  failure: string | null;
  sending: boolean;
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
              The session restarts before the next message and keeps the conversation. That message
              can raise the uncached input.
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
        Reload session
      </Button>
    </footer>
  );
}

function changedSummary(state: Extract<ToolsFooterState, { readonly kind: "changed" }>): string {
  const parts = [
    ...(state.onCount === 0 ? [] : [`${state.onCount} switched on`]),
    ...(state.serversLeftOut === 0
      ? []
      : [`${state.serversLeftOut} MCP ${state.serversLeftOut === 1 ? "server" : "servers"} off`]),
  ];
  const summary = parts.length === 0 ? "Nothing switched on" : parts.join(", ");
  return state.estimatedTokens === undefined || state.estimatedTokens === 0
    ? summary
    : `${summary}, about +${formatTokenEstimate(state.estimatedTokens)} tokens`;
}
