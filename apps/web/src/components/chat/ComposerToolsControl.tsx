import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS,
  type ClaudeSettings,
  type EnvironmentId,
  type ThreadId,
  type ProviderInstanceId,
  type ThreadToolOverrides,
  type OrchestrationV2ListThreadMcpServersResult,
  type ScopedThreadRef,
  threadToolOverridesNotice,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import { WrenchIcon } from "lucide-react";
import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MenuItem, MenuItemDetail } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { ComposerControl } from "./ComposerControl";
import { useComposerRowItemPlacement } from "./ComposerRow";
import { COMPOSER_ROW_PRIORITY, type ComposerRowItem } from "./composerRowItems";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  claudeSettingsForInstance,
  connectorsOn,
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

const NO_INVENTORY_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<OrchestrationV2ListThreadMcpServersResult, unknown>
> = Atom.make(AsyncResult.initial<OrchestrationV2ListThreadMcpServersResult, unknown>()).pipe(
  Atom.withLabel("thread-tools:no-inventory"),
);

/**
 * The row item for a thread's tools. Hidden for threads not on Claude and on servers without
 * per-thread tools; everything it shows comes from provider settings and the thread shell.
 */
export function useComposerToolsRowItem(threadRef: ScopedThreadRef | null): ComposerRowItem {
  const environmentId = threadRef?.environmentId ?? null;
  const shell = useQuietThreadShell(threadRef);
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const controlRef = useRef<ComposerToolsControlHandle>(null);
  const provider =
    config?.environment.capabilities.threadToolOverrides === true && shell !== null
      ? claudeSettingsForInstance(config.settings, shell.providerInstanceId)
      : null;
  return {
    id: "tools",
    priority: COMPOSER_ROW_PRIORITY.tools,
    hidden: environmentId === null || shell === null || provider === null,
    renderRowItem: () =>
      environmentId !== null && shell !== null && provider !== null ? (
        <ComposerToolsControl
          ref={controlRef}
          environmentId={environmentId}
          thread={shell}
          provider={provider}
        />
      ) : null,
    renderMenuRow: ({ openPopover, setValueElement }) => (
      <MenuItem onClick={() => openPopover(() => controlRef.current?.open())}>
        <WrenchIcon />
        Tools
        <MenuItemDetail ref={setValueElement} />
      </MenuItem>
    ),
  };
}

export interface ComposerToolsControlHandle {
  readonly open: () => void;
}

export function ComposerToolsControl({
  ref,
  environmentId,
  thread,
  provider,
}: {
  ref?: Ref<ComposerToolsControlHandle>;
  environmentId: EnvironmentId;
  thread: ComposerToolsThread;
  provider: Pick<ClaudeSettings, "omittedBuiltinTools" | "claudeAiConnectors">;
}) {
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const rowPlacement = useComposerRowItemPlacement();
  // Staged switches outlive a closed popover, so stopping a turn does not lose them.
  const [staged, setStaged] = useState<{
    readonly threadId: ThreadId;
    readonly value: ThreadToolOverrides;
  } | null>(null);
  const saved = thread.toolOverrides ?? EMPTY_TOOL_OVERRIDES;
  const stagedValue = staged?.threadId === thread.id ? staged.value : saved;
  const label = toolsLabel(provider, thread.toolOverrides);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl size="xs" aria-label={`${label.text}. Change tools for this thread`} />
        }
        data-thread-tools-trigger=""
      >
        <WrenchIcon aria-hidden="true" />
        <span className="whitespace-nowrap">
          <span className="font-medium text-foreground">Tools</span> {label.value}
        </span>
      </PopoverTrigger>
      {rowPlacement?.menuValue ? createPortal(label.value, rowPlacement.menuValue) : null}
      {open ? (
        <PopoverPopup
          side="top"
          align={rowPlacement?.inMenu ? "end" : "start"}
          width="lg"
          padding="none"
          aria-label="Tools for this thread"
          {...(rowPlacement?.inMenu
            ? { anchor: rowPlacement.anchor, finalFocus: rowPlacement.finalFocus }
            : {})}
          {...composerFloatingLayerProps}
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
    provider,
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
    // The popup caps its height at the space beside the anchor; the lists scroll inside that
    // cap so the footer and its Reload session button stay in view.
    <div className="flex max-h-[calc(var(--available-height)-2px)] flex-col">
      <header className="shrink-0 border-b px-3 pt-2.5 pb-2">
        <h2 className="font-semibold text-sm">Tools for this thread</h2>
        <p className="text-muted-foreground text-xs">
          Switch a left-out tool on, or a server off, for this thread only. Token figures are
          estimates of the context each adds.
        </p>
      </header>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
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
      </div>
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
              onChange={(on) => onStage(withMcpServerSwitched(staged, row.name, on, provider))}
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
                onStage(withMcpServerSwitched(staged, row.name, on, provider, connectorNames))
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
  return (
    <div className="border-t">
      <ToolSwitchRow
        label="claude.ai connectors"
        description={
          staged.claudeAiConnectors === "default"
            ? "Every connector on your Claude account; follows the provider default"
            : "Every connector on your Claude account; set for this thread"
        }
        estimatedTokens={CLAUDE_AI_CONNECTORS_ESTIMATED_TOKENS}
        on={connectorsOn(provider, staged)}
        onChange={(on) => onStage(withConnectorsMaster(staged, on, provider, connectorNames))}
        asListItem={false}
      />
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
    <footer className="flex shrink-0 items-center gap-3 border-t bg-card px-3 py-2.5">
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
