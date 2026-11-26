import { GitBranchIcon } from "lucide-react";

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

/**
 * The branch item's row in ⋯, opening the branch picker. The picker renders its own resolved
 * label into `setValueElement`, so the row shows exactly what the picker would.
 */
export function ComposerRowBranchMenuRow({
  setValueElement,
  onOpen,
}: {
  setValueElement: (element: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  return (
    <MenuItem onClick={onOpen}>
      <GitBranchIcon />
      <span ref={setValueElement} className="min-w-0 flex-1 truncate" />
      <MenuItemDetail>Branch</MenuItemDetail>
    </MenuItem>
  );
}
