import type { WaitingItemContextRecord } from "@t3tools/contracts";
import { MessageCircleIcon } from "lucide-react";

import { ContextChipShell } from "../contextChipParts";

/** A Discuss reference: which waiting item the message is about, with its title on hover. */
export function WaitingItemChip({ record }: { readonly record: WaitingItemContextRecord }) {
  return (
    <ContextChipShell
      kind="neutral"
      icon={<MessageCircleIcon />}
      label={record.label}
      tooltip={`${record.ref}: ${record.title}`}
    />
  );
}
