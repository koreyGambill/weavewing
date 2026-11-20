import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  executeAtomQuery,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputCursor,
  type TerminalOutputUpdate,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import {
  AuthPreviewOperateScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type ContextMenuItem,
  type ProviderInstanceId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useContext, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { readTextFromClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalSurfaceOptions,
} from "~/terminal/ghostty/surface";
import { type GhosttyColor, type GhosttyTheme } from "~/terminal/ghostty/core";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { isTerminalUrl, resolveTerminalLinkTarget } from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalToggleShortcut,
  isThreadNavigationShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import { readLocalApi } from "~/localApi";
import { useClientSettings } from "../hooks/useSettings";
import { getFileMetadataQueryAtom } from "../hooks/useFileMetadata";
import { FileMetadataThreadContext } from "../hooks/FileMetadataThreadProvider";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { registerTerminalLeaderInput } from "../shortcuts/dispatcher";
import { attachedTerminalSessionAtom } from "../state/terminalSessions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useEnvironmentScope } from "../state/session";
import { openTerminalLinkInPreview } from "./preview/openTerminalLinkInPreview";
import { terminalInputWriter } from "./terminal/terminalInputWriter";
import type { TerminalMoveMenu } from "./terminal/useTerminalMoveMenus";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useAtomCommand } from "../state/use-atom-command";
import { preventTerminalCloseShortcut } from "../lib/terminalCloseShortcut";
import { threadShortcutContext } from "./Sidebar.logic";
import {
  consumePendingTerminalFocus,
  focusTerminal,
  focusTerminalViewport,
  registerTerminalFocusTarget,
} from "../lib/terminalFocus";
import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../appearanceFonts";

function writeSystemMessage(
  terminal: Pick<GhosttyTerminalSurface, "write">,
  message: string,
): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

export function writeTerminalOutputUpdate(
  terminal: Pick<GhosttyTerminalSurface, "resetAndWrite" | "write">,
  update: TerminalOutputUpdate,
): void {
  if (update.type === "reset") {
    terminal.resetAndWrite(update.data);
  } else if (update.type === "append") {
    terminal.write(update.data);
  }
}

// Avoid formatting unbounded scrollback selections on every output update.
const MAX_COMPARED_SELECTION_CELLS = 3_000;

export function synchronizeTerminalOutput(
  terminal: Pick<
    GhosttyTerminalSurface,
    "resetAndWrite" | "write" | "getSelection" | "getSelectionCellCount" | "clearSelection"
  >,
  session: Pick<TerminalSessionState, "output" | "version">,
  cursor: TerminalOutputCursor,
): TerminalOutputCursor {
  if (session.version === 0) return cursor;
  const update = readTerminalOutputUpdate(session.output, cursor);
  if (update.type === "none") return update.cursor;
  const cells = terminal.getSelectionCellCount();
  const compared = cells <= MAX_COMPARED_SELECTION_CELLS;
  const selection = cells > 0 && compared ? terminal.getSelection() : "";
  writeTerminalOutputUpdate(terminal, update);
  if (!compared || (cells > 0 && terminal.getSelection() !== selection)) {
    terminal.clearSelection({ source: "output" });
  }
  return update.cursor;
}

/** Writes what changed between two session notifications: new output, then the error, again after a reset. */
export function synchronizeTerminalSession(
  terminal: Parameters<typeof synchronizeTerminalOutput>[0],
  previous: Pick<TerminalSessionState, "output" | "version" | "error">,
  session: Pick<TerminalSessionState, "output" | "version" | "error">,
  cursor: TerminalOutputCursor,
): TerminalOutputCursor {
  const nextCursor =
    session.version === previous.version && session.output === previous.output
      ? cursor
      : synchronizeTerminalOutput(terminal, session, cursor);
  // An attach failure can change only the error, keeping the last buffer.
  if (
    session.error !== null &&
    (session.error !== previous.error ||
      nextCursor.generation !== cursor.generation ||
      nextCursor.resetVersion !== cursor.resetVersion)
  ) {
    writeSystemMessage(terminal, session.error);
  }
  return nextCursor;
}

function parseTerminalColor(value: string, fallback: GhosttyColor): GhosttyColor {
  if (typeof document === "undefined") return fallback;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return fallback;

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return fallback;

  return {
    r: red ?? fallback.r,
    g: green ?? fallback.g,
    b: blue ?? fallback.b,
  };
}

function hexToGhosttyColor(hex: string): GhosttyColor {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const TERMINAL_PALETTES = {
  light: [
    "#000000",
    "#cd3131",
    "#107c10",
    "#949800",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#555555",
    "#666666",
    "#cd3131",
    "#14ce14",
    "#b5ba00",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#a5a5a5",
  ].map(hexToGhosttyColor),
  dark: [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#e5e5e5",
  ].map(hexToGhosttyColor),
};

// Read visibility when WASM finishes loading, not when setup starts.
function withLiveVisibility(
  visibleRef: { readonly current: boolean },
  options: Omit<GhosttyTerminalSurfaceOptions, "visible">,
): GhosttyTerminalSurfaceOptions {
  return {
    ...options,
    get visible() {
      return visibleRef.current;
    },
  };
}

function runtimeEnvSignature(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  return JSON.stringify(
    Object.entries(runtimeEnv)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function readThemeColor(styles: CSSStyleDeclaration, variable: string, fallback: string): string {
  return normalizeComputedColor(styles.getPropertyValue(variable), fallback);
}

function terminalFontOptions(family: string, size: number): { family?: string; size: number } {
  const trimmed = family.trim();
  return trimmed.length > 0 ? { family: trimmed, size } : { size };
}

export function terminalThemeFromApp(mountElement?: HTMLElement | null): GhosttyTheme {
  const drawerSurface =
    mountElement?.closest("[data-thread-terminal-drawer]") ??
    document.querySelector("[data-thread-terminal-drawer]") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const themeStyles = mountElement ? getComputedStyle(mountElement) : drawerStyles;
  const colorScheme = themeStyles.colorScheme;
  const isDark =
    colorScheme === "dark"
      ? true
      : colorScheme === "light"
        ? false
        : document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const bodyStyles = getComputedStyle(document.body);
  const rootThemeStyles = getComputedStyle(document.documentElement);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );
  const terminalBackground = readThemeColor(
    themeStyles,
    "--terminal-background",
    readThemeColor(rootThemeStyles, "--terminal-background", background),
  );
  const terminalForeground = readThemeColor(
    themeStyles,
    "--terminal-foreground",
    readThemeColor(rootThemeStyles, "--terminal-foreground", foreground),
  );
  const terminalCursor = readThemeColor(
    themeStyles,
    "--terminal-cursor",
    isDark ? "rgb(180, 203, 255)" : "rgb(38, 56, 78)",
  );
  const terminalSelection = readThemeColor(
    themeStyles,
    "--terminal-selection-background",
    isDark ? "rgba(180, 203, 255, 0.25)" : "rgba(37, 63, 99, 0.2)",
  );
  return {
    background: parseTerminalColor(
      terminalBackground,
      isDark ? { r: 14, g: 18, b: 24 } : { r: 255, g: 255, b: 255 },
    ),
    foreground: parseTerminalColor(
      terminalForeground,
      isDark ? { r: 237, g: 241, b: 247 } : { r: 28, g: 33, b: 41 },
    ),
    cursor: parseTerminalColor(
      terminalCursor,
      isDark ? { r: 180, g: 203, b: 255 } : { r: 38, g: 56, b: 78 },
    ),
    palette: TERMINAL_PALETTES[isDark ? "dark" : "light"],
    selectionBackground: terminalSelection,
  };
}

function terminalSelectionLineRange(position: { start: { y: number }; end: { y: number } }): {
  lineStart: number;
  lineEnd: number;
} {
  const lineStart = position.start.y + 1;
  return {
    lineStart,
    lineEnd: Math.max(lineStart, position.end.y + 1),
  };
}

export type TerminalContextMenuAction =
  | "add-to-chat"
  | "copy"
  | "paste"
  | "select-all"
  | "scroll-to-bottom"
  | "move"
  | `move:${string}`;

function terminalSelectionMenuItems(options?: {
  canAddToChat?: boolean;
}): ContextMenuItem<"add-to-chat" | "copy">[] {
  return [
    ...(options?.canAddToChat === false
      ? []
      : ([{ id: "add-to-chat", label: "Add to chat" }] satisfies ContextMenuItem<"add-to-chat">[])),
    { id: "copy", label: "Copy" },
  ];
}

function terminalMoveMenuItems(
  menu: TerminalMoveMenu | null | undefined,
): ContextMenuItem<TerminalContextMenuAction>[] {
  if (!menu) return [];
  const disabled = menu.disabledReason !== null;
  return [
    {
      id: "move",
      label: menu.label,
      separatorBefore: true,
      ...(disabled ? { disabled, detail: menu.disabledReason! } : {}),
      ...(menu.options && !disabled
        ? {
            children: menu.options.map((option) => ({
              id: `move:${option.id}` as const,
              label: option.label,
              ...(option.detail ? { detail: option.detail } : {}),
              ...(option.disabled ? { disabled: true } : {}),
            })),
          }
        : {}),
    },
  ];
}

function terminalContextMenuItems(options: {
  hasSelection: boolean;
  canAddToChat?: boolean;
  readOnly?: boolean;
  move?: TerminalMoveMenu | null | undefined;
}): ContextMenuItem<TerminalContextMenuAction>[] {
  const { hasSelection, canAddToChat = true } = options;
  return [
    ...terminalSelectionMenuItems({ canAddToChat }).map((item) => ({
      ...item,
      disabled: !hasSelection,
    })),
    { id: "paste", label: "Paste", ...(options.readOnly ? { disabled: true } : {}) },
    { id: "select-all", label: "Select all" },
    { id: "scroll-to-bottom", label: "Jump to latest" },
    ...terminalMoveMenuItems(options.move),
  ];
}

/**
 * A writable session's output generation. A new one is a fresh PTY (or a
 * reconnect) that has not seen the surface's grid yet.
 */
function writableSessionGeneration(
  session: TerminalSessionState,
  canOperate: boolean,
): number | null {
  return canOperate && session.version > 0 && session.status === "running"
    ? session.output.generation
    : null;
}

export function shouldHandleTerminalExit(
  current: TerminalSessionState["status"],
  synchronized: TerminalSessionState["status"],
  alreadyHandled: boolean,
  version: number,
): boolean {
  return (
    version > 0 &&
    (current === "closed" || current === "exited") &&
    current !== synchronized &&
    !alreadyHandled
  );
}

interface TerminalViewportProps {
  advancedTypography: boolean;
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  providerInstanceId?: ProviderInstanceId;
  /** `sessionId` is the ended shell's, so a close cannot reach a later one under this key. */
  onSessionExited: (sessionId: string | null) => void;
  /** The session moved to another workspace; drop this view without closing anything. */
  onSessionMoved?: () => void;
  onAddTerminalContext?: (selection: TerminalContextSelection) => void;
  /** Focuses the viewport when it mounts; otherwise focus arrives through `focusTerminal`. */
  autoFocus?: boolean;
  visible: boolean;
  keybindings: ResolvedKeybindingsConfig;
  moveMenu?: TerminalMoveMenu | null;
}

export function TerminalViewport(props: TerminalViewportProps) {
  const sessionKey = JSON.stringify([
    props.threadRef.environmentId,
    props.threadId,
    props.terminalId,
    props.cwd,
    props.worktreePath ?? null,
    runtimeEnvSignature(props.runtimeEnv),
  ]);
  return <TerminalSessionViewport key={sessionKey} {...props} />;
}

function TerminalSessionViewport({
  advancedTypography,
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  providerInstanceId,
  onSessionExited,
  onSessionMoved,
  onAddTerminalContext,
  autoFocus = false,
  visible,
  keybindings,
  moveMenu,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoFocusedRef = useRef(false);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const visibleRef = useRef(visible);
  const hiddenVersionRef = useRef(0);
  const environmentId = threadRef.environmentId;
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const hasTerminalWriteAccess = useEffectEvent(() =>
    readEnvironmentScope(environmentId, AuthTerminalOperateScope),
  );
  const canOpenHostEditor = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canReadFilesystem = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const [linkPath, setLinkPath] = useState<string | null>(null);
  const metadataThreadRef = useContext(FileMetadataThreadContext);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const hostname = serverConfig?.hostname;
  const readHostname = useEffectEvent(() => hostname);
  const linkMetadataQuery =
    linkPath !== null && canOpenHostEditor && canReadFilesystem
      ? getFileMetadataQueryAtom(
          environmentId,
          resolveTerminalLinkTarget(linkPath, cwd, hostname),
          cwd,
          metadataThreadRef,
        )
      : null;
  const canActivateTerminalLink = useEffectEvent((text: string) => {
    if (isTerminalUrl(text)) return true;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    if (text !== linkPath || !linkMetadataQuery) return false;
    const metadata = AsyncResult.getOrElse(appAtomRegistry.get(linkMetadataQuery), () => null);
    return metadata?.kind === "file" || metadata?.kind === "directory";
  });
  const validateTerminalLink = useEffectEvent(async (text: string) => {
    if (isTerminalUrl(text)) return true;
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    )
      return false;
    const query = getFileMetadataQueryAtom(
      environmentId,
      resolveTerminalLinkTarget(text, cwd, hostname),
      cwd,
      metadataThreadRef,
    );
    if (!query) return false;
    const result = await executeAtomQuery(appAtomRegistry, query, { reportFailure: false });
    return (
      result._tag === "Success" &&
      (result.value?.kind === "file" || result.value?.kind === "directory")
    );
  });
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
    worktreePath ?? cwd,
  );
  const openTerminalPath = useEffectEvent((target: string) => openInPreferredEditor(target));
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const runTerminalWrite = useAtomCommand(terminalEnvironment.write, {
    reportFailure: false,
  });
  // Recovery keeps the original registry-bound command after this viewport unmounts.
  const retainedTerminalWrite = useRef(runTerminalWrite);
  const runTerminalResize = useAtomCommand(terminalEnvironment.resize, {
    reportFailure: false,
  });
  const hasHandledExitRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const readKeybindings = useEffectEvent(() => keybindings);
  const readThreadShortcutContext = useEffectEvent(() => threadShortcutContext(threadRef));
  const handleSessionMoved = useEffectEvent(() => onSessionMoved?.());
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext?.(selection);
  });
  const canAddSelectionToChat = useEffectEvent(() => onAddTerminalContext !== undefined);
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const readMoveMenu = useEffectEvent(() => moveMenu);
  const terminalFontFamily = useClientSettings((settings) =>
    resolveTerminalFontPreference({
      advanced: advancedTypography,
      code: settings.fontFamilyCode,
      terminal: settings.fontFamilyTerminal,
    }),
  );
  const terminalFontSize = useClientSettings((settings) =>
    resolveTerminalFontSizePreference({
      advanced: advancedTypography,
      code: settings.fontSizeCode,
      terminal: settings.fontSizeTerminal,
    }),
  );
  const terminalFontRef = useRef({ family: terminalFontFamily, size: terminalFontSize });
  // Keyed by the launch (see TerminalViewport), so the atom is fixed for this surface.
  const terminalSessionAtom = attachedTerminalSessionAtom(environmentId, {
    threadId,
    terminalId,
    cwd,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(runtimeEnv ? { env: runtimeEnv } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
  });
  // Attaching starts with the viewport, while the WASM surface is still loading;
  // the surface reads the session itself, so output chunks never re-render here.
  useAtomMount(terminalSessionAtom);
  const readTerminalSession = useEffectEvent(() => appAtomRegistry.get(terminalSessionAtom));
  const handleSessionExited = useEffectEvent(() => {
    if (hasTerminalWriteAccess()) onSessionExited(readTerminalSession().sessionId);
  });
  const subscribeTerminalSession = useEffectEvent(
    (listener: (session: TerminalSessionState) => void) =>
      appAtomRegistry.subscribe(terminalSessionAtom, listener),
  );
  // The surface reports a resent grid like any other, so the next report is the retry.
  const resizeRetryGenerationRef = useRef<number | null>(null);
  const resizeTerminal = useEffectEvent(async (cols: number, rows: number) => {
    const generation = writableSessionGeneration(readTerminalSession(), hasTerminalWriteAccess());
    const retry = generation !== null && generation === resizeRetryGenerationRef.current;
    resizeRetryGenerationRef.current = null;
    if (generation === null) return;
    const result = await runTerminalResize({
      environmentId,
      input: { threadId, terminalId, cols, rows },
    });
    // Resend the current grid, not this one: a newer resize may already be queued behind it.
    if (!retry && result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      resizeRetryGenerationRef.current = generation;
      terminalRef.current?.resendSize();
    }
  });
  const outputCursorRef = useRef<TerminalOutputCursor>(INITIAL_TERMINAL_OUTPUT_CURSOR);
  const synchronizedStatusRef = useRef<TerminalSessionState["status"]>("closed");
  const synchronizeTerminalStatus = useEffectEvent(
    (
      terminal: GhosttyTerminalSurface,
      status: TerminalSessionState["status"],
      version: number,
      moved: boolean,
    ) => {
      const synchronized = synchronizedStatusRef.current;
      if (moved && status === "closed") {
        // The shell lives on under another key; closing this one could end it.
        if (!hasHandledExitRef.current) {
          hasHandledExitRef.current = true;
          window.setTimeout(() => handleSessionMoved(), 0);
        }
      } else if (version > 0 && status === "running") {
        hasHandledExitRef.current = false;
      } else if (
        shouldHandleTerminalExit(status, synchronized, hasHandledExitRef.current, version)
      ) {
        hasHandledExitRef.current = true;
        writeSystemMessage(terminal, status === "closed" ? "Terminal closed" : "Process exited");
        window.setTimeout(() => {
          if (hasHandledExitRef.current) {
            handleSessionExited();
          }
        }, 0);
      }
      if (version > 0) synchronizedStatusRef.current = status;
    },
  );
  const openLinkInPreview = useEffectEvent(
    (url: string, forceBrowser: boolean, fallbackToBrowser: () => void) =>
      openTerminalLinkInPreview({ url, threadRef, openPreview, fallbackToBrowser, forceBrowser }),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sets the terminal input's readOnly from the operate grant and consumes a pending focus request
  useLayoutEffect(() => {
    if (terminalRef.current) terminalRef.current.input.readOnly = !canOperateTerminal;
    if (canOperateTerminal && visibleRef.current)
      consumePendingTerminalFocus(threadRef, terminalId);
  }, [canOperateTerminal, terminalId, threadRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the imperative terminal's hovered link after filesystem metadata or editor permissions change
  useEffect(() => {
    if (!linkMetadataQuery) {
      terminalRef.current?.refreshLinkActivation();
      return;
    }
    return appAtomRegistry.subscribe(
      linkMetadataQuery,
      () => terminalRef.current?.refreshLinkActivation(),
      { immediate: true },
    );
  }, [linkMetadataQuery]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes visibility into the terminal surface before paint and consumes focus requests made while hidden
  useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!visible) hiddenVersionRef.current += 1;
    terminalRef.current?.setVisible(visible);
    // A request made while this viewport was hidden could not focus it.
    if (visible) consumePendingTerminalFocus(threadRef, terminalId);
  }, [terminalId, threadRef, visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies font family and size changes to the live Ghostty terminal surface
  useEffect(() => {
    const current = terminalFontRef.current;
    if (current.family === terminalFontFamily && current.size === terminalFontSize) return;
    terminalFontRef.current = { family: terminalFontFamily, size: terminalFontSize };
    void terminalRef.current?.setFont(terminalFontOptions(terminalFontFamily, terminalFontSize));
  }, [terminalFontFamily, terminalFontSize]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- creates the Ghostty terminal in the mount node and subscribes it to the terminal session
  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const localApi = readLocalApi();
    let cancelled = false;
    let teardown: (() => void) | null = null;
    let setupTerminal: GhosttyTerminalSurface | null = null;
    let setupCleanups: Array<() => void> = [];

    const setup = async (): Promise<(() => void) | null> => {
      const setupFont = terminalFontRef.current;
      const terminalOptions = withLiveVisibility(visibleRef, {
        theme: terminalThemeFromApp(mount),
        font: terminalFontOptions(setupFont.family, setupFont.size),
        onData: (data) => handleData(data),
        onBinary: (data) => void sendTerminalInput(data, "Terminal write failed", "binary"),
        onReply: (data) => void sendTerminalInput(data, "Terminal write failed", "reply"),
        onResize: (cols, rows) => void resizeTerminal(cols, rows),
        onSelectionChange: () => {},
        beforeKey: (event) => handleBeforeKey(event),
        onLinkActivate: (text, event) => handleLinkActivate(text, event),
        canActivateLink: (text) => canActivateTerminalLink(text),
        validateLink: (text) => validateTerminalLink(text),
        onLinkHover: (text) => setLinkPath(text !== null && !isTerminalUrl(text) ? text : null),
        // Surface listeners start before WASM loading finishes and the terminal handler exists.
        onContextMenu: (event) => {
          if (terminalRef.current) void showTerminalContextMenu(event);
        },
      });
      const terminal = await GhosttyTerminalSurface.create(mount, terminalOptions);
      if (cancelled) {
        terminal.dispose();
        return null;
      }
      terminal.setVisible(visibleRef.current);
      // Re-read theme changes during WASM loading, before the observer was installed.
      terminal.setTheme(terminalThemeFromApp(mount));
      setupTerminal = terminal;
      terminalRef.current = terminal;
      terminal.input.setAttribute("data-workspace-focus-default", "");
      terminal.input.readOnly = !hasTerminalWriteAccess();
      setupCleanups.push(
        registerTerminalLeaderInput(terminal.input, () => {
          const session = readTerminalSession();
          const generation = writableSessionGeneration(session, hasTerminalWriteAccess());
          if (!visibleRef.current || generation === null) return;
          const hiddenVersion = hiddenVersionRef.current;
          return () => {
            const current = readTerminalSession();
            if (
              cancelled ||
              !visibleRef.current ||
              hiddenVersionRef.current !== hiddenVersion ||
              current.lifecycleVersion !== session.lifecycleVersion ||
              writableSessionGeneration(current, hasTerminalWriteAccess()) !== generation
            )
              return;
            handleData("\x01");
          };
        }),
      );
      // Reapply font settings hydrated during loading, when terminalRef was null.
      const currentFont = terminalFontRef.current;
      if (currentFont.family !== setupFont.family || currentFont.size !== setupFont.size) {
        void terminal.setFont(terminalFontOptions(currentFont.family, currentFont.size));
      }
      const latestSession = readTerminalSession();
      terminal.setSharedGrid(latestSession.grid);
      const initialOutput = readTerminalOutputUpdate(
        latestSession.output,
        INITIAL_TERMINAL_OUTPUT_CURSOR,
      );
      if (initialOutput.type === "reset" && initialOutput.data.length > 0) {
        writeTerminalOutputUpdate(terminal, initialOutput);
      }
      outputCursorRef.current = initialOutput.cursor;
      if (latestSession.error !== null) writeSystemMessage(terminal, latestSession.error);
      synchronizedStatusRef.current = "closed";
      synchronizeTerminalStatus(
        terminal,
        latestSession.status,
        latestSession.version,
        latestSession.movedTo !== null,
      );
      // Read and subscribe in one synchronous step so no output lands between them.
      let previousSession = latestSession;
      let resizeGeneration = writableSessionGeneration(latestSession, hasTerminalWriteAccess());
      setupCleanups.push(
        subscribeTerminalSession((session) => {
          const nextResizeGeneration = writableSessionGeneration(session, hasTerminalWriteAccess());
          if (nextResizeGeneration !== resizeGeneration) {
            resizeGeneration = nextResizeGeneration;
            // The first fit can precede authorization/attach; replay the grid for each writable session, including
            // reconnects.
            if (nextResizeGeneration !== null) terminal.resendSize();
          }
          const previous = previousSession;
          previousSession = session;
          terminal.setSharedGrid(session.grid);
          synchronizeTerminalStatus(
            terminal,
            session.status,
            session.version,
            session.movedTo !== null,
          );
          outputCursorRef.current = synchronizeTerminalSession(
            terminal,
            previous,
            session,
            outputCursorRef.current,
          );
        }),
      );
      if (
        hasTerminalWriteAccess() &&
        visibleRef.current &&
        mount.contains(document.activeElement)
      ) {
        terminal.focus();
      }

      const clearSelectionAction = () => {
        selectionActionRequestIdRef.current += 1;
      };
      setupCleanups.push(clearSelectionAction);

      const readSelectionAction = (): {
        clipboardText: string;
        selection: TerminalContextSelection;
      } | null => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal || !activeTerminal.hasSelection()) {
          return null;
        }
        const selectionText = activeTerminal.getSelection();
        const selectionPosition = activeTerminal.getSelectionPosition();
        const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
        if (!selectionPosition || normalizedText.length === 0) {
          return null;
        }
        const { lineStart, lineEnd } = terminalSelectionLineRange(selectionPosition);
        return {
          clipboardText: selectionText,
          selection: {
            terminalId,
            terminalLabel: readTerminalLabel(),
            lineStart,
            lineEnd,
            text: normalizedText,
          },
        };
      };

      const addSelectionToChat = (clipboardText: string) => {
        // Output keeps moving the selected rows while a menu is open, so take
        // the line numbers now, and only if the same text is still selected.
        const current = readSelectionAction();
        if (current?.clipboardText !== clipboardText) return;
        handleAddTerminalContext(current.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      };

      const reportIfCurrent = (requestId: number, error: unknown, fallback: string) => {
        if (requestId !== selectionActionRequestIdRef.current) return;
        const activeTerminal = terminalRef.current;
        if (activeTerminal) {
          writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallback);
        }
      };

      const focusIfCurrent = (requestId: number) => {
        if (requestId === selectionActionRequestIdRef.current) {
          terminalRef.current?.focus();
        }
      };

      const copySelection = async (text: string, requestId: number) => {
        try {
          await writeTextToClipboard(text, "terminal selection");
        } catch (error) {
          reportIfCurrent(requestId, error, "Unable to copy terminal selection");
        }
        focusIfCurrent(requestId);
      };

      const pasteFromClipboard = async (requestId: number) => {
        if (!hasTerminalWriteAccess()) return;
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        try {
          // Let the surface own clipboard reads so paste shortcuts can supersede an in-flight menu paste.
          await activeTerminal.pasteFromClipboard(
            () => readTextFromClipboard("terminal input"),
            () => requestId === selectionActionRequestIdRef.current,
          );
        } catch (error) {
          reportIfCurrent(requestId, error, "Unable to read the clipboard");
          return;
        }
        focusIfCurrent(requestId);
      };

      const showTerminalContextMenu = async (event: MouseEvent) => {
        if (!localApi || !terminalRef.current) return;
        // Prevent default before awaits; native menus offer a permanently disabled Paste over the canvas.
        event.preventDefault();
        clearSelectionAction();
        const selectionAction = readSelectionAction();
        const requestId = selectionActionRequestIdRef.current;
        let clicked: TerminalContextMenuAction | null;
        try {
          clicked = await localApi.contextMenu.show(
            terminalContextMenuItems({
              hasSelection: selectionAction !== null,
              canAddToChat: canAddSelectionToChat(),
              readOnly: !hasTerminalWriteAccess(),
              move: readMoveMenu(),
            }),
            { x: event.clientX, y: event.clientY },
          );
        } catch (error) {
          reportIfCurrent(requestId, error, "Unable to open the terminal context menu");
          focusIfCurrent(requestId);
          return;
        }
        if (requestId !== selectionActionRequestIdRef.current || clicked === null) {
          return;
        }
        switch (clicked) {
          case "add-to-chat":
            if (selectionAction && canAddSelectionToChat()) {
              addSelectionToChat(selectionAction.clipboardText);
            }
            return;
          case "copy":
            if (selectionAction) await copySelection(selectionAction.clipboardText, requestId);
            return;
          case "paste":
            await pasteFromClipboard(requestId);
            return;
          case "select-all":
            terminalRef.current?.selectAll();
            focusIfCurrent(requestId);
            return;
          case "scroll-to-bottom":
            terminalRef.current?.scrollToBottom();
            focusIfCurrent(requestId);
            return;
          case "move":
            readMoveMenu()?.onMove(null);
            return;
          default:
            readMoveMenu()?.onMove(clicked.slice("move:".length));
            return;
        }
      };

      const readInputSession = () => appAtomRegistry.get(terminalSessionAtom);
      const canWriteInput = () => readEnvironmentScope(environmentId, AuthTerminalOperateScope);
      const writeInputChunk = (data: string, kind?: "binary" | "reply") =>
        retainedTerminalWrite.current({
          environmentId,
          input: kind
            ? { threadId, terminalId, data, [kind]: true }
            : { threadId, terminalId, data },
        });
      const sendTerminalInput = (
        data: string,
        fallbackError: string,
        kind?: "binary" | "reply",
      ) => {
        // The server rejects input until the shell runs, and each rejection would print an error.
        // Input belongs to the shell and surface it was typed into; a restart the client has seen drops what is left.
        const session = readTerminalSession();
        const generation = writableSessionGeneration(session, hasTerminalWriteAccess());
        const lifecycleVersion = session.lifecycleVersion;
        if (generation === null) return;
        const writeInput = terminalInputWriter(
          JSON.stringify([environmentId, threadId, terminalId]),
          () => appAtomRegistry.mount(terminalSessionAtom),
        );
        let reported = false;
        const report = (message: string) => {
          if (reported || terminalRef.current !== terminal) return;
          reported = true;
          writeSystemMessage(terminal, message);
        };
        return writeInput(
          data,
          async (chunk) => {
            const currentSession = readInputSession();
            if (
              terminalRef.current !== terminal ||
              currentSession.lifecycleVersion !== lifecycleVersion ||
              writableSessionGeneration(currentSession, canWriteInput()) !== generation
            ) {
              return "not-dispatched";
            }
            const result = await writeInputChunk(chunk, kind);
            if (result._tag === "Success") return true;
            if (terminalRef.current === terminal && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              report(error instanceof Error ? error.message : fallbackError);
            }
            return false;
          },
          // Close the bracket only for the process that saw it open; wait while its pid is unknown.
          async () => {
            const pid = session.summary?.pid ?? null;
            const current = readInputSession();
            const currentPid = current.summary?.pid ?? null;
            if (currentPid === null) return false;
            if (pid !== null && currentPid !== pid) return true;
            if (writableSessionGeneration(current, canWriteInput()) === null) return false;
            const result = await writeInputChunk("\x1b[201~");
            if (result._tag === "Success") return true;
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              report(error instanceof Error ? error.message : "Failed to close interrupted paste");
            }
            return false;
          },
          () => report("Terminal paste interrupted. Paste again when the terminal is ready."),
        );
      };

      function handleBeforeKey(event: KeyboardEvent): boolean {
        const currentKeybindings = readKeybindings();
        const options = { context: { terminalFocus: true, terminalOpen: true } };
        if (preventTerminalCloseShortcut(event, currentKeybindings)) {
          return false;
        }
        if (
          isTerminalToggleShortcut(event, currentKeybindings, options) ||
          isDiffToggleShortcut(event, currentKeybindings, options) ||
          // Match Sidebar's context, or a key it will reject skips the shell.
          isThreadNavigationShortcut(event, currentKeybindings, {
            context: { ...readThreadShortcutContext(), terminalFocus: true },
          })
        ) {
          return false;
        }

        const navigationData = terminalNavigationShortcutData(
          event,
          navigator.platform,
          terminalRef.current?.isAlternateScreen() ?? false,
        );
        if (navigationData !== null) {
          event.preventDefault();
          event.stopPropagation();
          terminalRef.current?.revealPrompt();
          void sendTerminalInput(navigationData, "Failed to move cursor");
          return false;
        }

        const deleteData = terminalDeleteShortcutData(event);
        if (deleteData !== null) {
          event.preventDefault();
          event.stopPropagation();
          terminalRef.current?.revealPrompt();
          void sendTerminalInput(deleteData, "Failed to delete terminal input");
          return false;
        }

        if (!isTerminalClearShortcut(event)) return true;
        event.preventDefault();
        event.stopPropagation();
        terminalRef.current?.revealPrompt();
        void sendTerminalInput("\u000c", "Failed to clear terminal");
        return false;
      }

      function handleLinkActivate(text: string, event: MouseEvent): void {
        if (
          !isTerminalUrl(text) &&
          !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
        )
          return;
        const latestTerminal = terminalRef.current;
        if (!latestTerminal) return;
        if (isTerminalUrl(text)) {
          if (!localApi) {
            writeSystemMessage(latestTerminal, "Opening links is unavailable in this browser.");
            return;
          }
          const fallbackToBrowser = () => {
            void localApi.shell.openExternal(text).catch((error: unknown) => {
              writeSystemMessage(
                latestTerminal,
                error instanceof Error ? error.message : "Unable to open link",
              );
            });
          };
          if (!readEnvironmentScope(environmentId, AuthPreviewOperateScope)) {
            fallbackToBrowser();
            return;
          }
          void openLinkInPreview(text, event.metaKey || event.ctrlKey, fallbackToBrowser).catch(
            (error: unknown) => {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Unable to open link",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            },
          );
          return;
        }
        const target = resolveTerminalLinkTarget(text, cwd, readHostname());
        void (async () => {
          const result = await openTerminalPath(target);
          if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
            return;
          }
          const error = squashAtomCommandFailure(result);
          writeSystemMessage(
            latestTerminal,
            error instanceof Error ? error.message : "Unable to open path",
          );
        })();
      }

      function handleData(data: string): void {
        void sendTerminalInput(data, "Terminal write failed");
      }

      const themeObserver = new MutationObserver(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        activeTerminal.setTheme(terminalThemeFromApp(containerRef.current));
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      setupCleanups.push(() => themeObserver.disconnect());

      const fitTimer = window.setTimeout(() => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) return;
        const wasAtBottom = activeTerminal.isAtBottom();
        activeTerminal.fit();
        if (wasAtBottom) {
          activeTerminal.scrollToBottom();
        }
      }, 30);
      setupCleanups.push(() => window.clearTimeout(fitTimer));

      const cleanups = setupCleanups;
      setupCleanups = [];
      setupTerminal = null;
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
        if (terminalRef.current === terminal) terminalRef.current = null;
        terminal.dispose();
      };
    };

    void setup()
      .then((nextTeardown) => {
        if (cancelled) {
          nextTeardown?.();
          return;
        }
        teardown = nextTeardown;
      })
      .catch((error: unknown) => {
        for (const cleanup of setupCleanups.toReversed()) cleanup();
        setupCleanups = [];
        if (terminalRef.current === setupTerminal) terminalRef.current = null;
        setupTerminal?.dispose();
        setupTerminal = null;
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Unable to initialize libghostty-vt";
        mount.textContent = `${message}. Close and reopen the terminal to retry.`;
      });

    return () => {
      cancelled = true;
      const hadFocus = mount.contains(document.activeElement);
      teardown?.();
      if (hasTerminalWriteAccess() && hadFocus && mount.isConnected) {
        mount.focus({ preventScroll: true });
      }
    };
  }, [cwd, environmentId, terminalId, terminalSessionAtom, threadId]);

  const attachContainer = (mount: HTMLDivElement) => {
    containerRef.current = mount;
    const focus = () =>
      focusTerminalViewport({
        mount,
        surface: terminalRef.current,
        canOperate: readEnvironmentScope(environmentId, AuthTerminalOperateScope),
        visible: visibleRef.current,
      });
    // Once per viewport: a re-attached ref (a fresh callback identity) must not
    // pull focus back on every render of a chatty terminal. As a request, it
    // waits for the grant or for the viewport to show when it cannot focus yet.
    if (autoFocus && !autoFocusedRef.current) {
      autoFocusedRef.current = true;
      focusTerminal(threadRef, terminalId);
    }
    const unregister = registerTerminalFocusTarget({
      threadRef,
      terminalId,
      element: mount,
      focus,
    });
    return () => {
      unregister();
      containerRef.current = null;
    };
  };
  return (
    <div
      ref={attachContainer}
      tabIndex={-1}
      className="relative h-full w-full overflow-hidden bg-(--terminal-background)"
    />
  );
}

/** Removes this client's tab for a session that moved elsewhere; the server keeps the session. */
function dropTerminalTab(threadRef: ScopedThreadRef, terminalId: string) {
  const store = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces.find(
    (entry) => entry.kind === "terminal" && entry.resourceId === terminalId,
  );
  if (surface) store.closeTerminal(threadRef, surface.id, terminalId);
}

export default function ThreadTerminalTile({
  threadRef,
  threadId,
  terminalId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  onCloseTerminal,
  onAddTerminalContext,
  keybindings,
  terminalLabel,
  moveMenu,
}: {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  onCloseTerminal: (
    terminalId: string,
    threadRef?: ScopedThreadRef,
    sessionId?: string | null,
  ) => void;
  onAddTerminalContext?: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
  terminalLabel?: string;
  moveMenu?: TerminalMoveMenu | null;
}) {
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  return (
    <section
      {...workspaceAreaProps("terminal", 5, "Terminal")}
      data-terminal-owner="right-panel"
      className="h-full min-h-0 min-w-0 overflow-hidden"
    >
      <TerminalViewport
        advancedTypography={advancedTypography}
        threadRef={threadRef}
        threadId={threadId}
        terminalId={terminalId}
        terminalLabel={terminalLabel ?? getTerminalLabel(terminalId)}
        cwd={cwd}
        {...(worktreePath !== undefined ? { worktreePath } : {})}
        {...(runtimeEnv ? { runtimeEnv } : {})}
        onSessionExited={(sessionId) => onCloseTerminal(terminalId, threadRef, sessionId)}
        onSessionMoved={() => dropTerminalTab(threadRef, terminalId)}
        {...(onAddTerminalContext ? { onAddTerminalContext } : {})}
        visible={visible}
        keybindings={keybindings}
        moveMenu={moveMenu ?? null}
      />
    </section>
  );
}
