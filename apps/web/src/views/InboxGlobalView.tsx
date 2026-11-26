import { InboxView } from "../components/inbox/InboxView";
import { MenuItemDetail } from "../components/ui/menu";
import { useInboxSignal } from "../state/inbox";

/** The Inbox as a view that spans threads: its tabs, rows and detail, unchanged. */
export function InboxGlobalView({ actions }: { actions: HTMLDivElement | null }) {
  return (
    <section aria-label="Inbox" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <InboxView actions={actions} />
    </section>
  );
}

/** Unread notifications, from the inbox stream the app already reads. */
export function InboxUnreadCount() {
  const { unread } = useInboxSignal();
  return unread === 0 ? null : <MenuItemDetail>{unread}</MenuItemDetail>;
}
