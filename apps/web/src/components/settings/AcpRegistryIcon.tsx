import {
  resolveOfficialAcpRegistryIconUrl,
  officialAcpRegistryIconUrlForAgentId,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { ACPRegistryIcon } from "../Icons";

export { officialAcpRegistryIconUrlForAgentId, resolveOfficialAcpRegistryIconUrl };

// Weavewing: the bundled registry mark; agent icons would load from the registry CDN on sight.
export function AcpRegistryAgentIcon({
  className,
  fallbackClassName,
}: {
  readonly icon: string | null;
  readonly className?: string;
  readonly fallbackClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground",
        className,
      )}
    >
      <ACPRegistryIcon className={cn("size-4", fallbackClassName)} data-slot="acp-icon-fallback" />
    </span>
  );
}
