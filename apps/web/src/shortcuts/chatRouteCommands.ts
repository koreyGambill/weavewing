import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isPreviewAvailableFor } from "../browser/previewRuntime";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { dispatchPreviewAction, type PreviewAction } from "../components/preview/previewActionBus";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { createNewThreadHandler } from "../hooks/useHandleNewThread";
import { readScratchProjectActions } from "../hooks/useScratchProject";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { isTerminalFocused } from "../lib/terminalFocus";
import { type CommandHandler, registerCommands } from "./dispatcher";

const CHAT_ROUTE_ID = "/_chat";

/**
 * New-thread and preview commands, live while a chat route is showing and no
 * modal page (Settings, Usage) covers it. Everything is read at event time, so
 * the scope is registered once instead of re-registering on every store change.
 */
export function installChatRouteCommands(router: AnyRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);
  const scratch = readScratchProjectActions(appAtomRegistry, handleNewThread);

  const readRouteTarget = () => resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const readRouteThreadRef = () => {
    const target = readRouteTarget();
    return target?.kind === "server" ? target.threadRef : null;
  };
  const readRouteEnvironmentId = () => {
    const target = readRouteTarget();
    if (!target) return null;
    return target.kind === "server"
      ? target.threadRef.environmentId
      : (useComposerDraftStore.getState().getDraftSession(target.draftId)?.environmentId ?? null);
  };
  const readPreviewOpen = () => {
    const threadRef = readRouteThreadRef();
    // Store-only on purpose: the URL-aware arbitration lives in ChatView's
    // preview toggle, which the action bus reaches.
    return threadRef
      ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) === "preview"
      : false;
  };
  // The current thread or draft only: without one, New thread in this project falls back to the
  // default place, which the resolver alone decides.
  const readThreadContext = () => {
    const target = readRouteTarget();
    const drafts = useComposerDraftStore.getState();
    const activeThread = target?.kind === "server" ? readThreadShell(target.threadRef) : null;
    const activeDraftThread = target
      ? target.kind === "server"
        ? drafts.getDraftThread(target.threadRef)
        : drafts.getDraftSession(target.draftId)
      : null;
    return {
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef: null,
      handleNewThread,
    };
  };
  const canOperatePreview = (environmentId: EnvironmentId) =>
    readEnvironmentScope(environmentId, AuthPreviewOperateScope);

  const claim = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const startDefaultPlace = () => void scratch.startDefaultPlace();

  const startNewLocal: CommandHandler = (event) => {
    claim(event);
    void startNewThreadFromContext(readThreadContext()).then((started) => {
      if (!started) startDefaultPlace();
    });
  };

  const previewCommand =
    (action: PreviewAction): CommandHandler =>
    (event) => {
      claim(event);
      const environmentId = readRouteEnvironmentId();
      if (environmentId && canOperatePreview(environmentId)) dispatchPreviewAction(action);
    };

  const newThreadCommands = {
    "chat.newLocal": startNewLocal,
    "chat.new": ((event) => {
      claim(event);
      startDefaultPlace();
    }) satisfies CommandHandler,
  };
  const onChatRoute = () =>
    router.state.matches.some((match) => match.routeId === CHAT_ROUTE_ID) &&
    !isCommandPaletteOpen();
  const onModalPage = () => router.state.matches.some((match) => isAppModalPage(match.pathname));
  // Over Settings or Usage, New thread closes the page for the draft, unless a key there is typing
  // into a field or another dialog is asking a question.
  const stopModalPageNewThread = registerCommands(newThreadCommands, {
    when: (event) => onChatRoute() && onModalPage() && !keyBelongsToModalPage(event.target),
  });
  const stopChatRouteCommands = registerCommands(
    {
      ...newThreadCommands,
      "preview.toggle": (event) => {
        claim(event);
        const threadRef = readRouteThreadRef();
        if (!threadRef || (!canOperatePreview(threadRef.environmentId) && !readPreviewOpen())) {
          return;
        }
        if (!isPreviewAvailableFor(threadRef.environmentId)) {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Preview is desktop-only",
              description: "Open T3 Code in the desktop app to use the in-app preview.",
            }),
          );
          return;
        }
        dispatchPreviewAction("toggle-panel");
      },
      "preview.refresh": previewCommand("refresh"),
      "preview.focusUrl": previewCommand("focus-url"),
      "preview.zoomIn": previewCommand("zoom-in"),
      "preview.zoomOut": previewCommand("zoom-out"),
      "preview.resetZoom": previewCommand("reset-zoom"),
      "preview.find": previewCommand("find"),
    },
    {
      when: () => onChatRoute() && !onModalPage(),
      context: () => {
        const threadRef = readRouteThreadRef();
        return {
          terminalOpen: threadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                threadRef,
              ).terminalOpen
            : false,
          previewOpen: readPreviewOpen(),
        };
      },
      onKeyDown: (event) => {
        if (event.key !== "Escape" || isTerminalFocused()) return false;
        const selection = useThreadSelectionStore.getState();
        if (selection.selectedThreadKeys.size === 0) return false;
        event.preventDefault();
        selection.clearSelection();
      },
    },
  );
  return () => {
    stopModalPageNewThread();
    stopChatRouteCommands();
  };
}

/** A field typing the key, or a dialog asking a question, keeps it on the page. */
function keyBelongsToModalPage(target: EventTarget | null) {
  const element = target as (Partial<HTMLElement> & Pick<Node, "ownerDocument">) | null;
  if (element === null) return false;
  return (
    element.isContentEditable === true ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName ?? "") ||
    element.ownerDocument?.querySelector(
      '[role="alertdialog"], [data-slot="dialog-popup"]:not([data-app-modal])',
    ) != null
  );
}
