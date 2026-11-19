import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OutsideWorkspaceEditGrant,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

const EMPTY_GRANTS: ReadonlyArray<OutsideWorkspaceEditGrant> = [];

function grantLabel(grant: OutsideWorkspaceEditGrant): string {
  return grant.kind === "file" ? grant.path : `Any file, from ${grant.path}`;
}

/**
 * The lock badge for a host file outside the workspace: says whether it can be edited,
 * asks before allowing edits, and lists every grant on the environment so each can be revoked.
 */
export function OutsideEditAccess({
  environmentId,
  cwd,
  relativePath,
  file,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly file: ProjectReadFileResult;
  readonly onChange: () => void;
}) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const grants = serverConfig?.settings.outsideWorkspaceEditGrants ?? EMPTY_GRANTS;
  const canGrant = useAtomValue(projectEnvironment.allowOutsideEdits.permissionAtom(environmentId));
  const allow = useAtomCommand(projectEnvironment.allowOutsideEdits);
  const revoke = useAtomCommand(projectEnvironment.revokeOutsideEdits);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<{ readonly _tag: string }>) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result._tag === "Success") onChange();
  };
  const grantFile = (scope: "file" | "workspace") => {
    setConfirming(false);
    void run(() => allow({ environmentId, input: { cwd, relativePath, scope } }));
  };
  const revokeGrant = (grant: OutsideWorkspaceEditGrant) =>
    void run(() => revoke({ environmentId, input: { grant } }));

  const editGrant = file.editGrant;
  const granted = editGrant !== undefined;
  const status = granted
    ? editGrant.kind === "file"
      ? "You allowed editing this file outside the workspace."
      : "You allowed editing any file outside this workspace while it is open."
    : file.canGrantEdit
      ? canGrant
        ? "This file is outside the workspace, so it opens read-only until you allow editing."
        : "This file is outside the workspace, and this connection cannot write files."
      : "This file stays read-only: T3 Code never edits credential folders, git metadata, hard-linked files, or its own state outside the workspace.";

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger
          render={
            <Badge
              variant={granted ? "warning" : "outline"}
              size="sm"
              render={<button type="button" />}
            />
          }
          data-outside-edit-access
        >
          {granted ? <LockOpenIcon aria-hidden="true" /> : <LockIcon aria-hidden="true" />}
          {granted ? "Editable outside workspace" : "Read-only"}
        </PopoverTrigger>
        <PopoverPopup width="md" align="end">
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">{status}</p>
            {granted && canGrant ? (
              <Button
                variant="destructive-outline"
                size="compact"
                disabled={busy}
                onClick={() => revokeGrant(editGrant)}
              >
                Turn off editing
              </Button>
            ) : null}
            {!granted && file.canGrantEdit && canGrant ? (
              <Button
                size="compact"
                disabled={busy}
                onClick={() => {
                  setPopoverOpen(false);
                  setConfirming(true);
                }}
              >
                Allow editing…
              </Button>
            ) : null}
            {grants.length > 0 ? (
              <div className="flex flex-col gap-1 border-t pt-3">
                <p className="text-xs font-medium">Edits allowed outside workspaces</p>
                <ul className="flex flex-col gap-1">
                  {grants.map((grant) => (
                    <li
                      key={`${grant.kind}:${grant.path}`}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span className="min-w-0 flex-1 break-all">{grantLabel(grant)}</span>
                      {canGrant ? (
                        <Button
                          variant="ghost"
                          size="icon-micro"
                          aria-label={`Remove edit access: ${grantLabel(grant)}`}
                          disabled={busy}
                          onClick={() => revokeGrant(grant)}
                        >
                          <XIcon />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow editing outside this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              {relativePath} is outside {cwd}. Anyone connected to this environment with permission
              to write files can then edit it from the Files tile. You can turn editing off again
              from the file's lock badge.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="outline" onClick={() => grantFile("workspace")}>
              Allow any file from this workspace
            </Button>
            <Button onClick={() => grantFile("file")}>Allow this file</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
