import { useParams } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { AutomationsView } from "../components/automations/AutomationsView";
import { EvidenceView } from "../components/evidence/EvidenceView";
import { InboxView } from "../components/inbox/InboxView";
import { useThreadToolsSlots } from "../components/threadToolsHost";
import {
  FLUSH_THREAD_TOOLS,
  ThreadInspect,
  ThreadToolSection,
} from "../components/ThreadToolViews";
import { Empty, EmptyDescription } from "../components/ui/empty";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { cn } from "../lib/utils";
import type { ThreadContextSection } from "../threadContextSidebarStore";

/**
 * A thread view's content for one thread. Its heading buttons and the Details card render into
 * the slots of whichever host encloses it, so the rail and the side area show the same view.
 */
export function ThreadViewBody({
  view,
  title,
  threadRef,
}: {
  view: ThreadContextSection;
  title: string;
  threadRef: ScopedThreadRef | null;
}) {
  const { actions, setDetails } = useThreadToolsSlots();
  // Inspect previews a draft's default context before its first message.
  const { draftId: routeDraftId } = useParams({ strict: false });
  const draftId = routeDraftId === undefined ? undefined : DraftId.make(routeDraftId);
  const draftSession = useComposerDraftStore((store) =>
    threadRef === null && draftId ? store.getDraftSession(draftId) : null,
  );
  const draft = draftId && draftSession ? { draftId, session: draftSession } : null;
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
        <ThreadInspect
          threadRef={scopeThreadRef(draft.session.environmentId, draft.session.threadId)}
          draftId={draft.draftId}
        />
      ) : (
        <Empty size="compact">
          <EmptyDescription>Open a thread to see its {title.toLowerCase()}.</EmptyDescription>
        </Empty>
      )}
    </section>
  );
}
