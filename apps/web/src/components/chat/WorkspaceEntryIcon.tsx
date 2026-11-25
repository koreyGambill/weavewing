import type { EnvironmentId, FilesystemEntryMetadata } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";

import { useFileMetadata } from "../../hooks/useFileMetadata";
import { PierreEntryIcon } from "./PierreEntryIcon";

export function WorkspaceEntryIcon(props: {
  path: string;
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
  metadata?: FilesystemEntryMetadata | undefined;
  theme: "light" | "dark";
}) {
  const queried = useFileMetadata(
    props.metadata ? null : props.environmentId,
    props.path,
    props.cwd,
  );
  const metadata = props.metadata ?? queried;
  return (
    <PierreEntryIcon
      pathValue={props.path}
      kind={metadata?.kind === "directory" ? "directory" : "file"}
      mimeType={metadata?.mimeType}
      theme={props.theme}
    />
  );
}

export function WorkspaceEntryTooltip(props: {
  path: string;
  label?: string;
  environmentId?: EnvironmentId | null | undefined;
  cwd?: string | undefined;
  metadata?: FilesystemEntryMetadata | undefined;
}) {
  const queried = useFileMetadata(
    props.metadata ? null : props.environmentId,
    props.path,
    props.cwd,
  );
  const metadata = props.metadata ?? queried;
  return (
    <>
      {props.label ?? props.path}
      {metadata?.byteLength === undefined
        ? null
        : ` · ${formatAttachmentSize(metadata.byteLength)}`}
    </>
  );
}
