import type { ReactNode } from "react";
import type { EnvironmentId, FilesystemEntryMetadata } from "@t3tools/contracts";
import { ContextChipLabel } from "../ContextChip";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

export function FileTagChipContent(props: {
  icon?: ReactNode;
  path: string;
  label: string;
  theme: "light" | "dark";
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
  /** Already read by the caller; the icon then reads nothing itself. */
  metadata?: FilesystemEntryMetadata | undefined;
}) {
  return (
    <>
      {props.icon ?? (
        <WorkspaceEntryIcon
          path={props.path}
          environmentId={props.environmentId}
          cwd={props.cwd}
          metadata={props.metadata}
          theme={props.theme}
        />
      )}
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}
