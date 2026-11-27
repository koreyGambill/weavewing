import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useId, useRef, useState } from "react";

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
  handoffBranchNameProblem,
  handoffDestination,
  handoffFailureMessage,
  handoffSuccessToast,
} from "./handoffWorktree.logic";
import {
  closeHandoffWorktree as close,
  handoffWorktreeDialogAtom,
  type HandoffWorktreeDialogRequest,
} from "./handoffWorktreeDialogState";

export function HandoffWorktreeDialogHost() {
  const { request, open } = useAtomValue(handoffWorktreeDialogAtom);
  return request ? (
    <HandoffWorktreeDialog key={request.sequence} request={request} open={open} />
  ) : null;
}

/** Names the new branch for a thread moving into its own worktree, the one choice a handoff needs. */
function HandoffWorktreeDialog({
  request,
  open,
}: {
  readonly request: HandoffWorktreeDialogRequest;
  readonly open: boolean;
}) {
  const { threadRef } = request;
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(threadRef.environmentId, thread.projectId) : null,
  );
  const settings = useEnvironmentSettings(threadRef.environmentId);
  // Xwing runs an environment's installs itself, so T3's setup script is not offered there.
  const intoEnvironment = settings.worktreeProvider === "xwing";
  const destination = handoffDestination(settings.worktreeProvider);
  const projectDefault = resolveProjectSettings(settings, project?.id ?? null, project ?? undefined)
    .settings.newWorktreesStartFromOrigin;
  const [branch, setBranch] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [startFromOrigin, setStartFromOrigin] = useState(projectDefault);
  const [runSetupScript, setRunSetupScript] = useState(true);
  const [pending, setPending] = useState(false);
  const branchInput = useRef<HTMLInputElement>(null);
  const problemId = useId();
  const canHandoff = useAtomValue(handoffThreadToWorktree.permissionAtom(threadRef.environmentId));
  // The dialog shows the server's refusal itself, beside the field it concerns.
  const handoff = useAtomCommand(handoffThreadToWorktree, {
    label: `Hand off to ${destination}`,
    reportFailure: false,
  });
  const busy = thread !== null && threadRuntimeIsActive(thread.runtime);
  const refuse = (message: string) => {
    setProblem(message);
    branchInput.current?.focus();
  };
  const submit = async () => {
    if (!thread || !canHandoff || pending || busy) return;
    const name = branch.trim();
    const invalid = handoffBranchNameProblem(name);
    if (invalid !== null) return refuse(invalid);
    setPending(true);
    const result = await handoff({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, branch: name, startFromOrigin, runSetupScript },
    });
    setPending(false);
    if (result._tag === "Failure") return refuse(handoffFailureMessage(result.cause));
    toastManager.add(handoffSuccessToast(result.value, { startFromOrigin, destination }));
    close();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) close();
      }}
    >
      <DialogPopup finalFocus={() => request.returnFocus}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Hand off to {destination}</DialogTitle>
            <DialogDescription>
              {intoEnvironment
                ? "Creates a new branch in a new Xwing environment and moves this thread there. The next turn starts in the environment with this conversation."
                : "Creates a new branch in its own worktree and moves this thread there. The next turn starts in the worktree with this conversation."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm">
                New branch
                <Input
                  ref={branchInput}
                  autoFocus
                  value={branch}
                  // Read-only rather than disabled, so a refusal can return focus here at once.
                  readOnly={pending}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={problem !== null}
                  aria-describedby={problem === null ? undefined : problemId}
                  onChange={(event) => {
                    setBranch(event.target.value);
                    setProblem(null);
                  }}
                />
              </label>
              {problem === null ? null : (
                <p id={problemId} role="alert" className="text-sm text-destructive-foreground">
                  {problem}
                </p>
              )}
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={startFromOrigin}
                  disabled={pending}
                  onCheckedChange={(checked) => setStartFromOrigin(checked === true)}
                />
                Start from the remote's latest commit
              </label>
              {intoEnvironment ? null : (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={runSetupScript}
                    disabled={pending}
                    onCheckedChange={(checked) => setRunSetupScript(checked === true)}
                  />
                  Run the project's setup script
                </label>
              )}
              {busy ? (
                <p className="text-sm text-muted-foreground">
                  Stop the turn or let it finish before handing off.
                </p>
              ) : null}
              {!canHandoff ? (
                <p className="text-sm text-muted-foreground">
                  This connection cannot create checkouts or move threads.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!thread || !canHandoff || busy || pending}>
              {pending ? "Handing off…" : "Hand off"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
