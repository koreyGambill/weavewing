import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, CopyIcon, SquareArrowOutUpRightIcon } from "lucide-react";

import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { shouldShowOpenInPicker } from "~/components/chat/OpenInPicker.logic";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useRemoteOpenState } from "~/remoteOpen";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { hostEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { serverEnvironment } from "~/state/server";

import { resolveFileHeaderActions } from "./fileHeaderActions.logic";
import { FileRemoteHeaderActions, useFileLinkState } from "./FileRemoteActions";
import { FileSurfaceAction } from "./fileSurfaceChrome";

/**
 * The core file actions for a surface bound to one file, such as Notes. Nothing here can move
 * the surface to another file, so the explorer toggle is left out.
 */
export function PinnedFileActions(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly projectName: string | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly availableEditors: ReadonlyArray<EditorId>;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hostEnvironmentId = useAtomValue(hostEnvironmentIdAtom);
  const remoteOpenState = useRemoteOpenState(props.environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const fileLink = useFileLinkState({
    environmentId: props.environmentId,
    absolutePath: props.absolutePath,
  });
  const actions = resolveFileHeaderActions({
    absolutePath: props.absolutePath,
    isFolder: false,
    isHostFile: true,
    pinned: true,
    openInSupported: shouldShowOpenInPicker({
      activeProjectName: props.projectName ?? undefined,
      activeThreadEnvironmentId: props.environmentId,
      primaryEnvironmentId,
      hostEnvironmentId,
      remoteOpenMode: remoteOpenState.mode,
    }),
    searchableText: false,
    truncated: false,
    fileLink: fileLink.state,
  });
  const { copyToClipboard: copyPath, isCopied: pathCopied } = useCopyToClipboard({
    target: "file path",
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy path", description: error.message }),
  });
  return (
    <>
      {actions.openIn?.disabledReason === null ? (
        <OpenInPicker
          environmentId={props.environmentId}
          keybindings={props.keybindings}
          availableEditors={props.availableEditors}
          enableShortcut={false}
          openInCwd={props.absolutePath}
          openInCwdIsFile
          compact
          revealFileManager={serverConfig?.shellRevealInFileManager === true}
        />
      ) : actions.openIn ? (
        <FileSurfaceAction
          label="Open file in preferred editor"
          disabledReason={actions.openIn.disabledReason}
          onPress={() => undefined}
        >
          <SquareArrowOutUpRightIcon className="size-3.5" />
        </FileSurfaceAction>
      ) : null}
      {actions.copyPath ? (
        <FileSurfaceAction
          label={pathCopied ? "Copied path" : "Copy path"}
          onPress={() => copyPath(props.absolutePath, undefined)}
        >
          {pathCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </FileSurfaceAction>
      ) : null}
      <FileRemoteHeaderActions
        actions={actions.remote}
        provider={fileLink.provider}
        threadRef={props.threadRef}
      />
      <FileRemoteHeaderActions
        actions={actions.remote}
        provider={fileLink.provider}
        threadRef={props.threadRef}
        overflow
      />
    </>
  );
}
