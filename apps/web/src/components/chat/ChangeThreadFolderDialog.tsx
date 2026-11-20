import {
  changeThreadFolderDialogAtom,
  closeChangeThreadFolder as close,
} from "./changeThreadFolderDialogState";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { CommandId, type ScopedThreadRef, type XwingEnvironmentId } from "@t3tools/contracts";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { FolderIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProject, useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { filesystemEnvironment, useFilesystemReadAccess } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { changeThreadFolder } from "../../state/xwingEnvironments";
import { Button } from "../ui/button";
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
import { useThreadEnvironmentUsage } from "../xwing/ThreadEnvironments";

export function ChangeThreadFolderDialogHost() {
  const threadRef = useAtomValue(changeThreadFolderDialogAtom);
  return threadRef ? (
    <ChangeThreadFolderDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  ) : null;
}

function ChangeThreadFolderDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? { environmentId: threadRef.environmentId, projectId: thread.projectId } : null,
  );
  const projects = useProjects().filter(
    (candidate) => candidate.environmentId === threadRef.environmentId,
  );
  const threads = useThreadShells().filter(
    (candidate) => candidate.environmentId === threadRef.environmentId,
  );
  const [folder, setFolder] = useState(thread?.worktreePath ?? project?.workspaceRoot ?? "~/code");
  const [xwingEnvironmentId, setXwingEnvironmentId] = useState<XwingEnvironmentId | undefined>();
  const [pending, setPending] = useState(false);
  const [expected] = useState({
    projectId: thread?.projectId,
    worktreePath: thread?.worktreePath ?? null,
    xwingEnvironmentId: thread?.developmentEnvironment?.xwingEnvironmentId ?? null,
  });
  const canChange = useAtomValue(changeThreadFolder.permissionAtom(threadRef.environmentId));
  const change = useAtomCommand(changeThreadFolder, "Change folder");
  const access = useFilesystemReadAccess(threadRef.environmentId);
  const linked = useThreadEnvironmentUsage(threadRef, true);
  const browse = useEnvironmentQuery(
    access.canReadFiles && folder.trim() !== ""
      ? filesystemEnvironment.browse({
          environmentId: threadRef.environmentId,
          input: { partialPath: folder },
        })
      : null,
  );
  const currentFolder = thread?.worktreePath ?? project?.workspaceRoot;
  const recent = [
    ...new Set(
      threads
        .toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .flatMap((candidate) => (candidate.worktreePath ? [candidate.worktreePath] : [])),
    ),
  ]
    .filter((path) => path !== currentFolder)
    .slice(0, 6);
  const busy = thread !== null && threadRuntimeIsActive(thread.runtime);
  const choose = (path: string, environment?: XwingEnvironmentId) => {
    setFolder(path);
    setXwingEnvironmentId(environment);
  };
  const submit = async () => {
    if (!thread || !canChange || pending || busy) return;
    setPending(true);
    const result = await change({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        commandId: CommandId.make(randomUUID()),
        expected,
        folder: folder.trim(),
        ...(xwingEnvironmentId ? { xwingEnvironmentId } : {}),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Folder changed",
        description: result.value.worktreePath ?? folder,
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
            <DialogTitle>Change folder</DialogTitle>
            <DialogDescription>
              The next turn starts a new agent session here with this conversation.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex flex-col gap-1.5 text-sm">
              Folder on the server's machine
              <Input
                autoFocus
                value={folder}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => choose(event.target.value)}
              />
            </label>
            <div className="mt-3 max-h-72 overflow-y-auto text-xs">
              <FolderChoice label="~/code" path="~/code" choose={choose} />
              {recent.length > 0 ? (
                <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground">Recent folders</p>
              ) : null}
              {recent.map((path) => (
                <FolderChoice key={path} label={path} path={path} choose={choose} />
              ))}
              {linked.environments.length > 0 ? (
                <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground">
                  Linked environments
                </p>
              ) : null}
              {linked.environments
                .filter((environment) => environment.status === "active")
                .flatMap((environment) =>
                  environment.repositories
                    .filter((repo) => repo.present)
                    .map((repo) => (
                      <FolderChoice
                        key={`${environment.id}:${repo.path}`}
                        label={`#${environment.number ?? environment.name} · ${repo.name} · ${repo.branch}`}
                        path={repo.path}
                        choose={(path) => choose(path, environment.id)}
                      />
                    )),
                )}
              {projects.length > 0 ? (
                <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground">Projects</p>
              ) : null}
              {projects
                .filter((candidate) => !candidate.isScratch)
                .map((candidate) => (
                  <FolderChoice
                    key={candidate.id}
                    label={candidate.title}
                    path={candidate.workspaceRoot}
                    choose={choose}
                  />
                ))}
              {browse.data ? (
                <p className="px-2 pt-3 pb-1 font-medium text-muted-foreground">
                  Folders in {browse.data.parentPath}
                </p>
              ) : null}
              {browse.data?.entries.map((entry) => (
                <FolderChoice
                  key={entry.fullPath}
                  label={entry.name}
                  path={entry.fullPath}
                  choose={(path) => choose(`${path}/`)}
                />
              ))}
            </div>
            {busy ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Stop the turn or let it finish before changing folder.
              </p>
            ) : null}
            {!canChange ? (
              <p className="mt-2 text-sm text-muted-foreground">
                This connection cannot change threads.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!thread || !canChange || busy || pending || folder.trim() === ""}
            >
              {pending ? "Changing…" : "Change folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function FolderChoice({
  label,
  path,
  choose,
}: {
  readonly label: string;
  readonly path: string;
  readonly choose: (path: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent focus-visible:outline focus-visible:outline-ring"
            onClick={() => choose(path)}
          />
        }
      >
        <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{path}</TooltipPopup>
    </Tooltip>
  );
}
