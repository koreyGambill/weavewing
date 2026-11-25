import type { OrchestrationV2DelegateRole } from "@t3tools/contracts";

import { Badge } from "../ui/badge";

/** The role a parent named when it delegated this child. Older children have none and show nothing. */
export function DelegateRoleChip(props: {
  readonly role: OrchestrationV2DelegateRole | null | undefined;
}) {
  if (!props.role) return null;
  return (
    <Badge variant="outline" size="sm" className="max-w-full" data-delegate-role={props.role}>
      <span className="truncate">{props.role}</span>
    </Badge>
  );
}
