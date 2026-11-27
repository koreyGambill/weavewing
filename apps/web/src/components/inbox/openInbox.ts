import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { useToolSidebarStore } from "../../toolSidebarStore";

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
 * Opens the Inbox for a notification or the palette: the side panel's Inbox at every width, which
 * on a phone opens as a sheet over the closed thread drawer.
 */
export function openInbox(notification?: NotificationTarget): void {
  openInboxView(notification);
}
