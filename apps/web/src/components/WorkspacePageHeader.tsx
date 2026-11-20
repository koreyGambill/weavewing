import type { ComponentPropsWithoutRef } from "react";

import { WorkspaceTitlebar } from "./WorkspaceTitlebar";

import { cn } from "../lib/utils";
import { WORKSPACE_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <WorkspaceTitlebar>
      <header
        data-sidebar-resize-width="left"
        className={cn(
          "flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left,padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
          electron && "drag-region",
          reserveNativeControls && "wco:pr-(--workspace-native-controls-inset)",
          WORKSPACE_TITLEBAR_INSET_CLASS,
          className,
        )}
        {...props}
      />
    </WorkspaceTitlebar>
  );
}
