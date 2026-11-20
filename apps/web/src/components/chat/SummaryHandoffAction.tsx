import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2RpcSchemas,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { FileOutputIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { focusThreadDraft, resolveThreadOpenRoute } from "../../lib/sideChatPane";
import { readThreadShell, useServerConfigs, useThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadPicker } from "../ThreadPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";

type Handoff = typeof OrchestrationV2RpcSchemas.prepareSummaryHandoff.output.Type;

export function SummaryHandoffAction({
  source,
  compact = false,
}: {
  readonly source: ScopedThreadRef;
  readonly compact?: boolean;
}) {
  const { environmentId, threadId } = source;
  const supported = useServerConfigs().get(environmentId)?.environment.capabilities.summaryHandoff;
  const canPrepare = useAtomValue(
    threadEnvironment.prepareSummaryHandoff.permissionAtom(environmentId),
  );
  const prepare = useAtomCommand(threadEnvironment.prepareSummaryHandoff, { reportFailure: false });
  const navigate = useNavigate();
  const request = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancel the in-flight summary RPC when the action unmounts
  useEffect(() => () => request.current?.abort(), []);
  const [open, setOpen] = useState(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [portable, setPortable] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState<ThreadId | null>(null);
  const targetRef = destination === null ? null : scopeThreadRef(environmentId, destination);
  const targetShell = useThreadShell(targetRef);

  if (!supported || !canPrepare) return null;

  const prepareHandoff = async (useSavedConversation: boolean) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    setHandoff(null);
    setPortable(useSavedConversation);
    const result = await prepare(
      {
        environmentId,
        input: { threadId, ...(useSavedConversation ? { strategy: "portable" } : {}) },
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    request.current = null;
    if (result._tag === "Success") {
      setHandoff(result.value);
      setText(result.value.kind === "native_unavailable" ? "" : result.value.text);
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error ? failure.message : "Could not prepare a handoff. Try again.",
    );
  };

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setHandoff(null);
      setText("");
      setDestination(null);
      void prepareHandoff(false);
    } else {
      request.current?.abort();
      request.current = null;
    }
  };

  const stage = async () => {
    const edited = text.trim();
    if (!targetRef || !edited) return;
    const target = readThreadShell(targetRef);
    if (target === null || target.archivedAt !== null) {
      setError("The destination is no longer available. Choose another thread.");
      setDestination(null);
      return;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      setError("You need permission to operate the destination thread.");
      return;
    }
    const draft = useComposerDraftStore.getState();
    const existing = draft.getComposerDraft(targetRef)?.prompt ?? "";
    draft.setPrompt(targetRef, existing ? `${existing}\n\n${edited}` : edited);
    changeOpen(false);
    const route = resolveThreadOpenRoute(targetRef, target);
    await navigate({ to: "/$environmentId/$threadId", params: route });
    focusThreadDraft(targetRef);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? "icon-xs" : "xs"}
            aria-label="Hand off summary"
            title={compact ? "Hand off summary" : undefined}
          />
        }
      >
        <FileOutputIcon />
        {compact ? null : "Hand off summary"}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Hand off summary</DialogTitle>
          <DialogDescription>
            Review the text and add it to another thread’s draft.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {handoff === null ? (
              error ? (
                <Button variant="outline" size="sm" onClick={() => void prepareHandoff(portable)}>
                  Retry
                </Button>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {portable ? "Preparing from saved messages…" : "Preparing from native history…"}
                </p>
              )
            ) : handoff.kind === "native_unavailable" ? (
              <>
                <p role="status" className="text-sm text-muted-foreground">
                  {handoff.reason}
                </p>
                <div>
                  <Button variant="outline" size="sm" onClick={() => void prepareHandoff(true)}>
                    Use saved conversation
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {handoff.kind === "native_summary"
                    ? "Prepared in a native fork using the source model."
                    : handoff.kind === "summary"
                      ? "Model summary of saved conversation messages."
                      : handoff.kind === "excerpt"
                        ? "Summary generation is unavailable. This is an excerpt of saved messages you can edit."
                        : "There are no saved messages to summarize. You can write the handoff yourself."}
                  {handoff.truncated ? " Only the most recent text fit." : ""}
                  {handoff.kind !== "native_summary" &&
                    " Provider-only history and attachments are outside this handoff."}
                </p>
                <Textarea
                  aria-label="Handoff text"
                  rows={6}
                  value={text}
                  onChange={(event) => setText(event.currentTarget.value)}
                />
                {targetShell ? (
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <p className="truncate text-sm">Destination: {targetShell.title}</p>
                    <Button size="xs" variant="ghost" onClick={() => setDestination(null)}>
                      Change
                    </Button>
                  </div>
                ) : null}
                <div hidden={targetShell !== null}>
                  <ThreadPicker
                    environmentId={environmentId}
                    excludeThreadId={threadId}
                    unavailableReason={(thread) =>
                      thread.lineage.sideChat ? "Side chat" : undefined
                    }
                    onSelect={setDestination}
                  />
                </div>
              </>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogAction
            disabled={!text.trim() || targetShell === null || targetShell.archivedAt !== null}
            onClick={() => void stage()}
          >
            Add to draft
          </DialogAction>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
