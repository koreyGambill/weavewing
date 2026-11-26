import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProject, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { handoffThreadToWorktree } from "../../state/xwingEnvironments";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  closeHandoffWorktree as close,
  handoffWorktreeDialogAtom,
} from "./handoffWorktreeDialogState";

export function HandoffWorktreeDialogHost() {
  const threadRef = useAtomValue(handoffWorktreeDialogAtom);
  return threadRef ? (
    <HandoffWorktreeDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  ) : null;
}

/** Names the new branch for a thread moving into its own worktree, the one choice a handoff needs. */
function HandoffWorktreeDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(threadRef.environmentId, thread.projectId) : null,
  );
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const projectDefault = resolveProjectSettings(settings, project?.id ?? null, project ?? undefined)
    .settings.newWorktreesStartFromOrigin;
  const [branch, setBranch] = useState("");
  const [startFromOrigin, setStartFromOrigin] = useState(projectDefault);
  const [runSetupScript, setRunSetupScript] = useState(true);
  const [pending, setPending] = useState(false);
  const canHandoff = useAtomValue(handoffThreadToWorktree.permissionAtom(threadRef.environmentId));
  const handoff = useAtomCommand(handoffThreadToWorktree, "Hand off to a worktree");
  const busy = thread !== null && threadRuntimeIsActive(thread.runtime);
  const submit = async () => {
    if (!thread || !canHandoff || pending || busy || branch.trim() === "") return;
    setPending(true);
    const result = await handoff({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        branch: branch.trim(),
        startFromOrigin,
        runSetupScript,
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Handed off to a worktree",
        description: result.value.worktreePath,
      });
      close();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Hand off to a worktree</DialogTitle>
            <DialogDescription>
              Creates a new branch in its own worktree and moves this thread there. The next turn
              starts in the worktree with this conversation.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm">
                New branch
                <Input
                  autoFocus
                  value={branch}
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={startFromOrigin}
                  disabled={pending}
                  onCheckedChange={(checked) => setStartFromOrigin(checked === true)}
                />
                Start from the remote's latest commit
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={runSetupScript}
                  disabled={pending}
                  onCheckedChange={(checked) => setRunSetupScript(checked === true)}
                />
                Run the project's setup script
              </label>
              {busy ? (
                <p className="text-sm text-muted-foreground">
                  Stop the turn or let it finish before handing off.
                </p>
              ) : null}
              {!canHandoff ? (
                <p className="text-sm text-muted-foreground">
                  This connection cannot create worktrees or move threads.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!thread || !canHandoff || busy || pending || branch.trim() === ""}
            >
              {pending ? "Handing off…" : "Hand off"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
