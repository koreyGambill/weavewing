import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { useToolSidebarStore } from "../../toolSidebarStore";

interface NotificationTarget {
  readonly environmentId: string;
  readonly id: string;
}

// The sidebar's own breakpoint: below it the thread list is a drawer, not always on screen.
const THREAD_LIST_ALWAYS_SHOWN_QUERY = "(min-width: 768px)";

/** Opens the Inbox in the side panel, on one notification when given, else on its list. */
export function openInboxView(notification?: NotificationTarget): void {
  const inbox = useThreadContextSidebarStore.getState();
  inbox.setInboxTab("inbox");
  if (notification) inbox.selectInbox({ kind: "notification", ...notification });
  useToolSidebarStore.getState().dispatch({ type: "show", view: "inbox" });
}

/**
 * Opens the Inbox where it leaves the thread list in view: the side panel where the list always
 * shows, the sidebar's Inbox on phone widths.
 */
export function openInbox(notification?: NotificationTarget): void {
  if (window.matchMedia(THREAD_LIST_ALWAYS_SHOWN_QUERY).matches) {
    openInboxView(notification);
    return;
  }
  useThreadContextSidebarStore.getState().show("inbox", notification ? { notification } : {});
}
