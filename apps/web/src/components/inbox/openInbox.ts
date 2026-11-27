import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { useToolSidebarStore } from "../../toolSidebarStore";
import { isMobileViewport } from "../ui/sidebar";

interface NotificationTarget {
  readonly environmentId: string;
  readonly id: string;
}

/** Opens the Inbox in the side panel, on one notification when given, else on its list. */
export function openInboxView(notification?: NotificationTarget): void {
  const inbox = useThreadContextSidebarStore.getState();
  inbox.setInboxTab("inbox");
  if (notification) inbox.selectInbox({ kind: "notification", ...notification });
  useToolSidebarStore.getState().dispatch({ type: "show", view: "inbox" });
}

/**
 * Opens the Inbox where it leaves the thread list in view: the side panel where the sidebar is
 * not a drawer, the sidebar's Inbox on phone widths. On desktop a sidebar left on its own Inbox
 * returns to Threads, so one Inbox shows and the thread list stays visible.
 */
export function openInbox(notification?: NotificationTarget): void {
  const sidebar = useThreadContextSidebarStore.getState();
  if (isMobileViewport()) {
    sidebar.show("inbox", notification ? { notification } : {});
    return;
  }
  if (sidebar.view === "inbox") sidebar.selectView("threads");
  openInboxView(notification);
}
