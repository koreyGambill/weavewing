import { useAssetUrlState } from "../../assets/assetUrls";
import { fileLinkShownPath } from "@t3tools/client-runtime/workspace-basename-lookup";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuSource, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { memo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { FolderIcon } from "lucide-react";

import { contextMenuSourceOf } from "../../contextMenuSource";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { shouldOpenMarkdownFileLinkInEditor } from "../../markdown-links";
import type { markdownFileCopyPaths } from "../../markdown-links";
import { documentChipKindForFileName } from "../../pierre-icons";
import { ContextChip } from "../ContextChip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FileTagChipContent } from "./FileTagChip";
import {
  hasMarkdownFilePrimaryAction,
  markdownFileCopyMenuItems,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./MarkdownFileLink.logic";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { WorkspaceEntryTooltip } from "./WorkspaceEntryIcon";

interface MarkdownFileLinkProps {
  environmentId: EnvironmentId | null;
  targetPath: string;
  /** The destination as the agent wrote it, shown until a read confirms a relative link's file. */
  authoredPath: string;
  /** Reads where a relative link points; absent for links that open as written. */
  verifyPath?: (() => Promise<string | null>) | undefined;
  iconPath: string;
  isAppBundle?: boolean;
  workspaceRelativePath: string | null;
  panelPath: string | null;
  line?: number | undefined;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  onOpen?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenInPanel: (panelPath: string, line: number | undefined) => void;
  resolveCopyPaths: () => Promise<ReturnType<typeof markdownFileCopyPaths>>;
  openInEditorMenuLabel: string;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenMedia?: (() => void) | undefined;
  onReveal?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  revealLabel?: string | undefined;
}

const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

// Every tooltip open reads afresh; only the newest read may update its chip.
let fileLinkCheckSequence = 0;

export const MarkdownFileLink = memo(function MarkdownFileLink({
  environmentId,
  targetPath,
  authoredPath,
  verifyPath,
  iconPath,
  isAppBundle = false,
  workspaceRelativePath,
  panelPath,
  line,
  label,
  copyMarkdown,
  theme,
  threadRef,
  onOpen,
  onOpenInPanel,
  openInEditorMenuLabel,
  onOpenInBrowser,
  onOpenMedia,
  onReveal,
  revealLabel,
  resolveCopyPaths,
}: MarkdownFileLinkProps) {
  const checkKey = `${environmentId}\u0000${targetPath}\u0000${authoredPath}`;
  const [check, setCheck] = useState<{ id: number; key: string; path: string | null } | null>(null);
  // A different link drops the last result, so a late read can never land on it.
  if (check !== null && check.key !== checkKey) setCheck(null);
  const verifiedPath = verifyPath && check?.key === checkKey ? check.path : null;
  const confirmed = verifyPath === undefined || verifiedPath !== null;
  const shownPath = fileLinkShownPath(authoredPath, verifiedPath);
  // Nothing reads an unconfirmed relative link's guessed path, the icon and tooltip included.
  const readPath = verifiedPath ?? iconPath;
  const verifyOnOpen = (open: boolean) => {
    if (!open || !verifyPath) return;
    fileLinkCheckSequence += 1;
    const id = fileLinkCheckSequence;
    const key = checkKey;
    const settle = (path: string | null) =>
      setCheck((previous) => (previous?.id === id ? { id, key, path } : previous));
    setCheck({ id, key, path: null });
    verifyPath().then(settle, () => settle(null));
  };
  const handleOpenInEditor = () => {
    if (!onOpen) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpen();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleOpenInFilePreview = () => {
    if (threadRef && panelPath) {
      onOpenInPanel(panelPath, line);
      return;
    }
    if (onOpenMedia) {
      onOpenMedia();
      return;
    }
    handleOpenInEditor();
  };

  const handleOpenInBrowser = () => {
    if (!onOpenInBrowser) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpenInBrowser();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleRevealInFileManager = () => {
    if (!onReveal) {
      return;
    }
    void (async () => {
      try {
        const result = await onReveal();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleCopy = (resolveValue: () => Promise<string>, title: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    const value = resolveValue().then((text) => formatFilePathForClipboard(text, targetPath));
    // Start the write before workspace lookup finishes so Safari retains the user gesture.
    const write =
      typeof navigator.clipboard.write === "function" && typeof ClipboardItem !== "undefined"
        ? navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": value.then((text) => new Blob([text], { type: "text/plain" })),
            }),
          ])
        : value.then((text) => navigator.clipboard.writeText(text));
    void Promise.all([write, value]).catch((error) => {
      reportMarkdownActionFailure(
        { operation: "copy-file-path", target: targetPath, copyTarget: title },
        error,
      );
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };

  const showFileContextMenu = async (
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const api = readLocalApi();
    if (!api) return;

    try {
      const copyItems = markdownFileCopyMenuItems({ targetPath, workspaceRelativePath });
      const clicked = await api.contextMenu.show(
        [
          ...(onOpenMedia ? ([{ id: "preview-media", label: "Preview media" }] as const) : []),
          ...(onOpen ? ([{ id: "open", label: openInEditorMenuLabel }] as const) : []),
          ...(onOpenInBrowser
            ? ([{ id: "open-in-browser", label: "Open in integrated browser" }] as const)
            : []),
          ...(onReveal && revealLabel ? ([{ id: "reveal", label: revealLabel }] as const) : []),
          ...copyItems.map(({ id, label }) => ({ id, label })),
        ] as const,
        position,
        source,
      );

      if (clicked === "preview-media") {
        onOpenMedia?.();
        return;
      }
      if (clicked === "open") {
        handleOpenInEditor();
        return;
      }
      if (clicked === "open-in-browser") {
        handleOpenInBrowser();
        return;
      }
      if (clicked === "reveal") {
        handleRevealInFileManager();
        return;
      }
      if (clicked === "copy-relative" || clicked === "copy-full") {
        handleCopy(
          () =>
            resolveCopyPaths().then((paths) =>
              clicked === "copy-relative" ? paths.relativePath : paths.fullPath,
            ),
          clicked === "copy-relative" ? "Relative path" : "Full path",
        );
      }
    } catch (cause) {
      reportMarkdownActionFailure(
        { operation: "show-file-context-menu", target: targetPath },
        cause,
      );
    }
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const position =
      event.clientX === 0 && event.clientY === 0
        ? (() => {
            const bounds = event.currentTarget.getBoundingClientRect();
            return { x: bounds.left, y: bounds.bottom };
          })()
        : { x: event.clientX, y: event.clientY };
    void showFileContextMenu(position, contextMenuSourceOf(event));
  };

  const canOpenInEditor = onOpen !== undefined;
  const canOpenInBrowser = onOpenInBrowser !== undefined;
  const canOpenInPanel = threadRef !== undefined && Boolean(panelPath);
  const hasPrimaryAction = hasMarkdownFilePrimaryAction({
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
    canOpenMedia: onOpenMedia !== undefined,
  });
  const useBrowserPrimaryAction = shouldUseMarkdownFileBrowserPrimaryAction({
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
  });
  const chipKind = documentChipKindForFileName(iconPath) ?? "mention";

  return (
    <Tooltip onOpenChange={verifyOnOpen}>
      <TooltipTrigger
        render={
          hasPrimaryAction ? (
            <ContextChip
              kind={chipKind}
              dir="ltr"
              render={<a href={shownPath} />}
              className={MARKDOWN_FILE_LINK_CLASS_NAME}
              data-markdown-copy={copyMarkdown}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (onOpen && shouldOpenMarkdownFileLinkInEditor(event)) {
                  handleOpenInEditor();
                  return;
                }
                if (useBrowserPrimaryAction) {
                  handleOpenInBrowser();
                  return;
                }
                handleOpenInFilePreview();
              }}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent
                icon={
                  isAppBundle && confirmed ? (
                    <AppBundleIcon environmentId={environmentId} path={readPath} />
                  ) : undefined
                }
                path={readPath}
                environmentId={confirmed ? environmentId : null}
                label={label}
                theme={theme}
              />
            </ContextChip>
          ) : (
            <ContextChip
              kind={chipKind}
              dir="ltr"
              render={<button type="button" />}
              aria-label={`File options for ${label}`}
              aria-haspopup="menu"
              className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, "select-text")}
              data-markdown-copy={copyMarkdown}
              onClick={handleContextMenu}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent
                icon={
                  isAppBundle && confirmed ? (
                    <AppBundleIcon environmentId={environmentId} path={readPath} />
                  ) : undefined
                }
                path={readPath}
                environmentId={confirmed ? environmentId : null}
                label={label}
                theme={theme}
              />
            </ContextChip>
          )
        }
      />
      <TooltipPopup side="top" variant="code">
        <WorkspaceEntryTooltip
          path={readPath}
          label={shownPath}
          environmentId={confirmed ? environmentId : null}
        />
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.targetPath === next.targetPath &&
    previous.authoredPath === next.authoredPath &&
    previous.verifyPath === next.verifyPath &&
    previous.iconPath === next.iconPath &&
    previous.environmentId === next.environmentId &&
    previous.workspaceRelativePath === next.workspaceRelativePath &&
    previous.panelPath === next.panelPath &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.threadRef === next.threadRef &&
    previous.isAppBundle === next.isAppBundle &&
    previous.onOpen === next.onOpen &&
    previous.onOpenInPanel === next.onOpenInPanel &&
    previous.openInEditorMenuLabel === next.openInEditorMenuLabel &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.onOpenMedia === next.onOpenMedia &&
    previous.onReveal === next.onReveal &&
    previous.resolveCopyPaths === next.resolveCopyPaths &&
    previous.revealLabel === next.revealLabel
  );
}

function AppBundleIcon(props: { environmentId: EnvironmentId | null; path: string }) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "native-app-icon",
    app: { _tag: "app-path", path: props.path },
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const url = asset._tag === "Success" && asset.url !== failedUrl ? asset.url : null;
  const loaded = url !== null && loadedUrl === url;
  return (
    <span
      data-app-bundle-icon=""
      aria-hidden="true"
      className="relative me-[0.2em] inline-block size-[1em] align-[calc((1cap-1em)/2)]"
    >
      <FolderIcon className={cn("size-full text-icon-muted", loaded && "invisible")} />
      {url !== null && (
        <img
          src={url}
          alt=""
          className={cn("absolute inset-0 size-full object-contain", !loaded && "invisible")}
          onLoad={() => setLoadedUrl(url)}
          onError={() => setFailedUrl(url)}
        />
      )}
    </span>
  );
}
