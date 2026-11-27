import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { LandingPage } from "../components/evidence/EvidenceView";
import { ThreadTodosView } from "../components/reviews/ThreadListView";
import { ThreadTimelineView } from "../components/ThreadTimelineView";
import {
  ThreadArtifacts,
  ThreadDetailsSlot,
  ThreadEnvironments,
  ThreadInspect,
  ThreadLinks,
  ThreadRelated,
} from "../components/ThreadToolViews";
import type { ThreadViewId } from "../components/ToolSidebar.logic";
import { Empty, EmptyDescription } from "../components/ui/empty";
import { useEvidenceEnvironment } from "../state/evidence";
import { ViewSection, ViewSectionGroup } from "./ViewSection";
import type { ViewSlots, ViewTarget } from "./viewRegistry";

/**
 * A thread view's content for its target. It renders only from what its host passes, so every
 * host shows the same view. Merged views stack their parts as sections that load as they show.
 */
export function ThreadViewBody({
  view,
  title,
  target,
  slots,
}: {
  view: ThreadViewId;
  title: string;
  target: ViewTarget;
  slots: ViewSlots;
}) {
  const { threadRef, draft } = target;
  return (
    <section aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      {threadRef ? (
        <ThreadViewContent view={view} threadRef={threadRef} slots={slots} />
      ) : view === "details" && draft ? (
        <ViewSection id="details:inspect" title="Context and usage">
          {() => <ThreadInspect threadRef={draft.threadRef} draftId={draft.draftId} />}
        </ViewSection>
      ) : (
        <Empty size="compact">
          <EmptyDescription>Open a thread to see its {title.toLowerCase()}.</EmptyDescription>
        </Empty>
      )}
    </section>
  );
}

function Padded({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-1 pb-3">{children}</div>;
}

function ThreadViewContent({
  view,
  threadRef,
  slots,
}: {
  view: ThreadViewId;
  threadRef: ScopedThreadRef;
  slots: ViewSlots;
}) {
  switch (view) {
    case "checklist":
      return (
        <div className="px-2.5 py-2.5">
          <ThreadTodosView threadRef={threadRef} />
        </div>
      );
    case "artifacts":
      return (
        <div className="px-2.5 py-2.5">
          <ThreadArtifacts threadRef={threadRef} />
        </div>
      );
    case "links":
      return (
        <ViewSectionGroup>
          <ViewSection id="links:links" title="Pull requests, tickets, links and files">
            {(actions) => (
              <Padded>
                <ThreadLinks threadRef={threadRef} actions={actions} />
              </Padded>
            )}
          </ViewSection>
          <ViewSection
            id="links:threads"
            title="Delegated, forked and messaged threads"
            after="links:links"
          >
            {() => (
              <Padded>
                <ThreadRelated threadRef={threadRef} />
              </Padded>
            )}
          </ViewSection>
        </ViewSectionGroup>
      );
    case "activity":
      return (
        <ViewSectionGroup>
          <ViewSection id="activity:runs" title="Runs">
            {(actions) => (
              <Padded>
                <ThreadTimelineView threadRef={threadRef} actions={actions} />
              </Padded>
            )}
          </ViewSection>
          <ViewSection id="activity:landings" title="Landings" after="activity:runs">
            {() => (
              <Padded>
                <ThreadLandings threadRef={threadRef} />
              </Padded>
            )}
          </ViewSection>
        </ViewSectionGroup>
      );
    case "details":
      return (
        <ViewSectionGroup>
          <ViewSection id="details:thread" title="Thread">
            {() => <ThreadDetailsSlot threadRef={threadRef} detailsRef={slots.setDetails} />}
          </ViewSection>
          <ViewSection id="details:environments" title="Environments" after="details:thread">
            {() => (
              <Padded>
                <ThreadEnvironments threadRef={threadRef} />
              </Padded>
            )}
          </ViewSection>
          <ViewSection id="details:inspect" title="Context and usage" after="details:environments">
            {() => <ThreadInspect threadRef={threadRef} />}
          </ViewSection>
        </ViewSectionGroup>
      );
  }
}

/** This thread's landings, newest first, as the Evidence view lists them. */
function ThreadLandings({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environmentId = useEvidenceEnvironment(threadRef);
  if (environmentId === null) {
    return (
      <p className="text-xs text-muted-foreground">This connection doesn't record evidence.</p>
    );
  }
  return (
    <div className="@container/evidence flex min-w-0 flex-col gap-2 text-xs">
      <LandingPage
        environmentId={environmentId}
        input={{ threadId: threadRef.threadId }}
        showThread={false}
        first
      />
    </div>
  );
}
