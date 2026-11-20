import { type RunId, type ScopedThreadRef } from "@t3tools/contracts";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { newThreadId } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COMPOSER_ICON_COLOR } from "./ComposerControl";

export function RewindContextButton(props: {
  readonly thread: ScopedThreadRef;
  readonly runId: RunId;
  readonly disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const rewindContext = useOrchestrationCommand(threadEnvironment.rewindContext, {
    reportFailure: false,
  });
  const rewind = async () => {
    const api = readLocalApi();
    if (!api || busy || props.disabled) return;
    setBusy(true);
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        "Rewind conversation context?\nEarlier messages will move into Earlier conversation, where you can reopen them or bring them back. Your files, draft, and checkpoints stay in this thread.",
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) {
      setBusy(false);
      return;
    }
    const result = await rewindContext({
      environmentId: props.thread.environmentId,
      input: {
        sourceThreadId: props.thread.threadId,
        targetThreadId: newThreadId(),
        runId: props.runId,
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not rewind conversation context",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label="Rewind conversation context"
            disabled={busy || props.disabled}
            onClick={() => void rewind()}
          />
        }
      >
        <HistoryIcon className={`size-4 ${COMPOSER_ICON_COLOR}`} />
      </TooltipTrigger>
      <TooltipPopup side="top">Rewind conversation context</TooltipPopup>
    </Tooltip>
  );
}
