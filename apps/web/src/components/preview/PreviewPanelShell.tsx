import type { ReactNode } from "react";

export type PreviewPanelMode = "embedded";

export function PreviewPanelShell({ children }: { mode: PreviewPanelMode; children: ReactNode }) {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      data-preview-panel-mode="embedded"
    >
      {children}
    </div>
  );
}
