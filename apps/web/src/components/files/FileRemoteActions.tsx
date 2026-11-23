import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { EllipsisIcon, ExternalLinkIcon, LinkIcon } from "lucide-react";

import { useOpenLink } from "~/browser/useOpenLink";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuItemDetail,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { SourceControlIconArtwork } from "~/components/SourceControlIconArtwork";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { sourceControlEnvironment } from "~/state/sourceControl";

import {
  type FileLinkState,
  type FileRemoteAction,
  resolveFileRemoteActions,
} from "./fileHeaderActions.logic";
import { FileSurfaceAction } from "./fileSurfaceChrome";

/** Null when the file has no host path or this connection cannot read files. */
export function useFileLinkState(input: {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string | null;
  readonly line?: number | undefined;
  readonly endLine?: number | undefined;
}): { readonly state: FileLinkState | null; readonly provider: string | null } {
  const canRead = useEnvironmentScope(input.environmentId, AuthFilesystemReadScope);
  const query = useEnvironmentQuery(
    canRead && input.absolutePath !== null
      ? sourceControlEnvironment.fileLink({
          environmentId: input.environmentId,
          input: {
            path: input.absolutePath,
            ...(input.line === undefined ? {} : { line: input.line }),
            ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
          },
        })
      : null,
  );
  if (!canRead || input.absolutePath === null) return { state: null, provider: null };
  const link = query.data;
  return {
    state:
      link !== null
        ? { status: "ready", link }
        : query.error !== null
          ? { status: "failed" }
          : { status: "loading" },
    provider: link?._tag === "Available" ? link.provider : null,
  };
}

/** Opens a link the way chat links open, or copies it. */
export function useRunFileRemoteAction(threadRef: ScopedThreadRef | null | undefined) {
  const openLink = useOpenLink(threadRef);
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: "link",
    onCopy: (label) => toastManager.add({ type: "success", title: `Copied ${label}` }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy link", description: error.message }),
  });
  return (action: FileRemoteAction, event?: { metaKey: boolean; ctrlKey: boolean }) => {
    if (action.url === null || action.disabledReason !== null) return;
    if (action.kind === "copy") {
      copyToClipboard(action.url, action.label.replace(/^Copy /u, ""));
      return;
    }
    void openLink(action.url, event ? { event } : {}).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not open link",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  };
}

function ForgeIcon(props: { readonly provider: string | null; readonly className: string }) {
  const artwork = props.provider === null ? null : sourceControlClients.get(props.provider).icon;
  return artwork === null ? (
    <ExternalLinkIcon className={props.className} />
  ) : (
    <SourceControlIconArtwork icon={artwork} className={props.className} />
  );
}

/**
 * The header's forge buttons, or with `overflow` its More file actions menu, which sits at the
 * end of the core group.
 */
export function FileRemoteHeaderActions(props: {
  readonly actions: ReadonlyArray<FileRemoteAction>;
  readonly provider: string | null;
  readonly threadRef: ScopedThreadRef | null | undefined;
  readonly overflow?: boolean;
}) {
  const run = useRunFileRemoteAction(props.threadRef);
  const placement = props.overflow === true ? "overflow" : "header";
  const actions = props.actions.filter((action) => action.placement === placement);
  if (placement === "header") {
    return actions.map((action) => (
      <FileSurfaceAction
        key={action.id}
        label={action.label}
        detail={action.detail}
        disabledReason={action.disabledReason}
        onPress={() => run(action)}
      >
        <ForgeIcon provider={props.provider} className="size-3.5" />
      </FileSurfaceAction>
    ));
  }
  if (actions.length === 0) return null;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  className="shrink-0"
                  variant="ghost"
                  size="icon-micro"
                  aria-label="More file actions"
                />
              }
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>More file actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <FileRemoteMenuItems actions={actions} onRun={run} />
      </MenuPopup>
    </Menu>
  );
}

/** Menu rows for remote actions; a disabled row shows its reason, since rows have no tooltip. */
function FileRemoteMenuItems(props: {
  readonly actions: ReadonlyArray<FileRemoteAction>;
  readonly onRun: (action: FileRemoteAction) => void;
}) {
  return props.actions.map((action) => (
    <MenuItem
      key={action.id}
      disabled={action.disabledReason !== null}
      onClick={() => props.onRun(action)}
    >
      {action.kind === "copy" ? <LinkIcon /> : <ExternalLinkIcon />}
      <MenuItemLabel>{action.label}</MenuItemLabel>
      {(action.disabledReason ?? action.detail) ? (
        <MenuItemDetail>{action.disabledReason ?? action.detail}</MenuItemDetail>
      ) : null}
    </MenuItem>
  ));
}

/** Forge rows for a file row's menu; it reads git only while the menu is open. */
export function FileRemoteMenuSection(props: {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string | null;
  readonly threadRef: ScopedThreadRef;
}) {
  const link = useFileLinkState(props);
  const run = useRunFileRemoteAction(props.threadRef);
  if (link.state === null) return null;
  return (
    <>
      <MenuSeparator />
      <FileRemoteMenuItems actions={resolveFileRemoteActions(link.state)} onRun={run} />
    </>
  );
}
