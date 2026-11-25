import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";

import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useQuietThreadShell } from "~/state/entities";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MenuItem, MenuItemDetail } from "../ui/menu";

/** The computer item's row in ⋯: the machine label, opening the machine select. */
export function ComposerRowComputerMenuRow(props: {
  environment: EnvironmentOption | null;
  label: string;
  onOpen: (() => void) | undefined;
}) {
  return (
    <MenuItem disabled={props.onOpen === undefined} onClick={props.onOpen}>
      <EnvironmentMachineIcon kind={props.environment?.machine ?? "server"} />
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <MenuItemDetail>Computer</MenuItemDetail>
    </MenuItem>
  );
}

/** The branch item's row in ⋯: the thread's branch, opening the branch picker. */
export function ComposerRowBranchMenuRow(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId: DraftId | undefined;
  branchOverride: string | null | undefined;
  onOpen: () => void;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shellBranch = useQuietThreadShell(threadRef)?.branch;
  const draftBranch = useComposerDraftStore(
    (store) =>
      (props.draftId ? store.getDraftSession(props.draftId) : store.getDraftThreadByRef(threadRef))
        ?.branch,
  );
  const branch =
    props.branchOverride !== undefined ? props.branchOverride : (shellBranch ?? draftBranch);
  return (
    <MenuItem onClick={props.onOpen}>
      <GitBranchIcon />
      <span className="min-w-0 flex-1 truncate">{branch ?? "Select ref"}</span>
      <MenuItemDetail>Branch</MenuItemDetail>
    </MenuItem>
  );
}
