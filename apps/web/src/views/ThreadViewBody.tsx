import { AutomationsView } from "../components/automations/AutomationsView";
import { EvidenceView } from "../components/evidence/EvidenceView";
import { InboxView } from "../components/inbox/InboxView";
import {
  FLUSH_THREAD_TOOLS,
  ThreadInspect,
  ThreadToolSection,
} from "../components/ThreadToolViews";
import { Empty, EmptyDescription } from "../components/ui/empty";
import { cn } from "../lib/utils";
import type { ThreadContextSection } from "../threadContextSidebarStore";
import type { ViewSlots, ViewTarget } from "./viewRegistry";

/**
 * A thread view's content for its target. It renders only from what its host passes, so the
 * rail, the side area and later hosts show the same view.
 */
export function ThreadViewBody({
  view,
  title,
  target,
  slots,
}: {
  view: ThreadContextSection;
  title: string;
  target: ViewTarget;
  slots: ViewSlots;
}) {
  const { threadRef, draft } = target;
  const { actions, setDetails } = slots;
  return (
    <section
      aria-label={title}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        view !== "inbox" && !FLUSH_THREAD_TOOLS.has(view) && "overflow-auto px-2.5 py-2.5",
      )}
    >
      {view === "inbox" ? (
        <InboxView actions={actions} />
      ) : view === "automations" ? (
        <AutomationsView threadRef={threadRef} />
      ) : view === "evidence" ? (
        <EvidenceView threadRef={threadRef} />
      ) : threadRef ? (
        <ThreadToolSection
          section={view}
          threadRef={threadRef}
          detailsRef={setDetails}
          actions={actions}
        />
      ) : view === "inspect" && draft ? (
        <ThreadInspect threadRef={draft.threadRef} draftId={draft.draftId} />
      ) : (
        <Empty size="compact">
          <EmptyDescription>Open a thread to see its {title.toLowerCase()}.</EmptyDescription>
        </Empty>
      )}
    </section>
  );
}
