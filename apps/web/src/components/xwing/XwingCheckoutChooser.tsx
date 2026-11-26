import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  type DevelopmentEnvironmentCheckoutChoice,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type XwingEnvironmentId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Boxes, PlusIcon } from "lucide-react";
import { type Ref, useImperativeHandle, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  developmentEnvironmentCheckouts,
  selectDevelopmentEnvironmentCheckout,
  useXwingEnvironmentsSupport,
} from "../../state/xwingEnvironments";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ComposerControl } from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { CreateEnvironmentForm } from "./XwingEnvironmentLifecycle";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Badge } from "../ui/badge";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { filterXwingCheckoutChoices, xwingEnvironmentLabel } from "./xwingEnvironments.logic";

export interface XwingCheckoutChooserHandle {
  /** Opens the chooser anchored to `anchor`, returning focus there when it closes. */
  readonly open: (anchor: HTMLElement) => void;
}

/**
 * Picks the Xwing environment a thread works in. The server lists the project's checkouts and
 * resolves the chosen one; a draft keeps the choice for its first send, and a started thread
 * moves when it is stopped.
 */
export function XwingCheckoutChooser({
  ref,
  hideTrigger = false,
  environmentId,
  threadId,
  draftId,
  projectId,
  createOpen = false,
  showLabel = false,
  onCreateOpenChange,
}: {
  readonly ref?: Ref<XwingCheckoutChooserHandle>;
  /** Leaves the trigger out, for a row whose location menu opens the chooser instead. */
  readonly hideTrigger?: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId: DraftId | null | undefined;
  readonly projectId: ProjectId;
  readonly createOpen?: boolean;
  readonly showLabel?: boolean;
  readonly onCreateOpenChange?: (open: boolean) => void;
}) {
  const supported = useXwingEnvironmentsSupport(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const composerFloatingLayerProps = useComposerMenuProps();
  const threadRef = scopeThreadRef(environmentId, threadId);
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const selectCheckout = useAtomCommand(
    selectDevelopmentEnvironmentCheckout,
    "Move thread to Xwing environment",
  );
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      open: (next) => {
        setAnchor(next);
        setOpen(true);
      },
    }),
    [],
  );
  const [query, setQuery] = useState("");
  const [localCreateOpen, setLocalCreateOpen] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const creating = createOpen || localCreateOpen;
  const setCreating = (next: boolean) => {
    if (!next && createPending) return;
    setLocalCreateOpen(next);
    onCreateOpenChange?.(next);
  };
  const list = useEnvironmentQuery(
    supported && canRead && open
      ? developmentEnvironmentCheckouts({ environmentId, input: { projectId } })
      : null,
  );
  if (!supported || !canRead || (serverThread !== null && !canOperate)) return null;

  const bound = serverThread?.developmentEnvironment ?? null;
  const selected =
    serverThread !== null
      ? bound && {
          id: bound.xwingEnvironmentId,
          label: xwingEnvironmentLabel({
            number: bound.number ?? undefined,
            name: bound.name,
          }),
        }
      : (draftThread?.xwingEnvironment ?? null);
  const choices = list.data ?? [];
  const visible = filterXwingCheckoutChoices(choices, query);
  const statusText =
    list.error ??
    (list.data === null
      ? "Loading environments…"
      : choices.length === 0
        ? "No active Xwing environment has a checkout of this project."
        : null);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const choose = (choice: DevelopmentEnvironmentCheckoutChoice) => {
    handleOpenChange(false);
    if (choice.xwingEnvironmentId === selected?.id) return;
    if (serverThread !== null) {
      void selectCheckout({
        environmentId,
        input: {
          threadId: serverThread.id,
          commandId: CommandId.make(randomUUID()),
          expected: {
            worktreePath: serverThread.worktreePath,
            xwingEnvironmentId: bound?.xwingEnvironmentId ?? null,
          },
          xwingEnvironmentId: choice.xwingEnvironmentId,
        },
      });
      return;
    }
    setDraftThreadContext(draftId ?? threadRef, {
      branch: choice.branch === "" ? null : choice.branch,
      worktreePath: choice.checkoutPath,
      envMode: "worktree",
      xwingEnvironment: {
        id: choice.xwingEnvironmentId,
        label: xwingEnvironmentLabel(choice),
      },
      projectRef: scopeProjectRef(environmentId, projectId),
    });
  };
  const selectCreated = async (id: XwingEnvironmentId, name: string) => {
    if (serverThread !== null) {
      const selected = await selectCheckout({
        environmentId,
        input: {
          threadId: serverThread.id,
          commandId: CommandId.make(randomUUID()),
          expected: {
            worktreePath: serverThread.worktreePath,
            xwingEnvironmentId: bound?.xwingEnvironmentId ?? null,
          },
          xwingEnvironmentId: id,
        },
      });
      if (selected._tag !== "Success") return;
    } else {
      setDraftThreadContext(draftId ?? threadRef, {
        branch: null,
        worktreePath: null,
        envMode: "local",
        xwingEnvironment: { id, label: name },
        projectRef: scopeProjectRef(environmentId, projectId),
      });
    }
    setCreating(false);
  };
  const byId = new Map(choices.map((choice) => [choice.xwingEnvironmentId as string, choice]));

  return (
    <>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogPopup showCloseButton={!createPending}>
          <DialogTitle>New development environment</DialogTitle>
          <CreateEnvironmentForm
            threadRef={threadRef}
            projectId={projectId}
            onOpen={selectCreated}
            onCancel={() => setCreating(false)}
            allowOpenPartial={false}
            onPendingChange={setCreatePending}
          />
        </DialogPopup>
      </Dialog>
      <Combobox
        items={choices.map((choice) => choice.xwingEnvironmentId as string)}
        filteredItems={visible.map((choice) => choice.xwingEnvironmentId as string)}
        autoHighlight
        open={open}
        onOpenChange={handleOpenChange}
        value={selected?.id ?? null}
        onValueChange={(value) => {
          const choice = typeof value === "string" ? byId.get(value) : undefined;
          if (choice) choose(choice);
        }}
      >
        {hideTrigger ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <ComboboxTrigger
                  render={showLabel ? <ThreadDetailsControl /> : <ComposerControl size="xs" />}
                  className="min-w-0 shrink active:scale-100"
                  aria-label="Xwing environment"
                  data-composer-context-control
                />
              }
            >
              <Boxes className="size-3 shrink-0" />
              {selected || showLabel ? (
                <ComposerContextLabel>
                  {selected?.label ?? "Choose environment"}
                </ComposerContextLabel>
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {selected
                ? serverThread !== null
                  ? `Works in ${selected.label}. Choose another environment to move this stopped thread.`
                  : `Starts in ${selected.label}.`
                : "Work in an Xwing environment"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ComboboxPopup
          align="start"
          side="top"
          className="flex w-[min(24rem,calc(100vw-2rem))] flex-col"
          {...composerFloatingLayerProps}
          {...(anchor ? { anchor, finalFocus: () => anchor } : {})}
        >
          {canOperate ? (
            <Button
              variant="ghost"
              size="compact"
              onClick={() => {
                handleOpenChange(false);
                setCreating(true);
              }}
            >
              <PlusIcon /> New environment
            </Button>
          ) : null}
          <ComboboxSearchInput
            placeholder="Search environments..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {statusText === null ? <ComboboxEmpty>No environment matches.</ComboboxEmpty> : null}
          <ComboboxList className="max-h-64">
            {visible.map((choice, index) => (
              <ComboboxItem
                key={choice.xwingEnvironmentId}
                index={index}
                value={choice.xwingEnvironmentId}
                hideIndicator
              >
                <div className="flex w-full min-w-0 items-center gap-2">
                  <span className="shrink-0 font-medium">{xwingEnvironmentLabel(choice)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {choice.branch}
                  </span>
                  {choice.ticket ? (
                    <Badge size="sm" variant="outline">
                      {choice.ticket}
                    </Badge>
                  ) : null}
                </div>
              </ComboboxItem>
            ))}
          </ComboboxList>
          {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
        </ComboboxPopup>
      </Combobox>
    </>
  );
}
