import type { ScopedThreadRef } from "@t3tools/contracts";
import { FilesIcon } from "lucide-react";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { Button } from "../ui/button";
export function ThreadReviewsButton({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Artifacts"
      onClick={() =>
        useThreadContextSidebarStore.getState().show("artifacts", { thread: threadRef })
      }
    >
      <FilesIcon />
    </Button>
  );
}
