import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";

import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { useComposerDraftStore } from "../composerDraftStore";
import { CONVERSATION_TAB_ID, getTileGroups } from "../threadTileLayout";
import { requestWorkspaceFocus } from "./workspaceFocus";
import type { ToolCallDiffTarget } from "../diffPanelStore";
import { selectThreadTileLayout, useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side chat's tool diffs in its parent's diff panel and runs its shell commands
 * in the parent's terminal drawer, since the embedded view hides its own. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection and the drawer are not panel state.
 */
export interface SideChatParentPanel {
  readonly hostRef: ScopedThreadRef;
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
  readonly runShellCommand: (command: string) => void;
}

/**
 * Opens a tab-based side chat on its parent route. Other threads have their own routes.
 */
export function resolveThreadOpenRoute(
  threadRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "lineage"> | null,
): ScopedThreadRef {
  const parentThreadId =
    thread?.lineage.sideChat === true && thread.lineage.sideChatAnchor === undefined
      ? thread.lineage.parentThreadId
      : null;
  if (parentThreadId === null) return threadRef;
  const parentRef = scopeThreadRef(threadRef.environmentId, parentThreadId);
  useRightPanelStore.getState().openSideChat(parentRef, threadRef.threadId);
  return parentRef;
}

/** Stages the side chat in its parent's draft using the composer’s removable thread reference. */
export function bringSideChatToDraft(
  parent: ScopedThreadRef,
  child: ScopedThreadRef,
  title: string,
) {
  useComposerDraftStore.getState().addThreadContexts(parent, [threadContextRecord(child, title)], {
    insertAtCaret: false,
  });
}

/** Selects the thread's main chat tile, including when a side chat shares that tile. */
export function showThreadConversation(ref: ScopedThreadRef) {
  const panels = useRightPanelStore.getState();
  const layout = selectThreadTileLayout(panels.byThreadKey, ref);
  const group = getTileGroups(layout).find((group) => group.tabs.includes(CONVERSATION_TAB_ID));
  if (group)
    panels.applyTileAction(ref, {
      type: "activate",
      groupId: group.id,
      tabId: CONVERSATION_TAB_ID,
    });
}

/** Reveals and focuses a specific thread's composer after a tab switch or navigation. */
export function focusThreadDraft(ref: ScopedThreadRef) {
  showThreadConversation(ref);
  requestWorkspaceFocus({
    area: "document",
    selector: `[data-chat-composer-thread="${CSS.escape(scopedThreadKey(ref))}"] [contenteditable="true"]`,
  });
}
