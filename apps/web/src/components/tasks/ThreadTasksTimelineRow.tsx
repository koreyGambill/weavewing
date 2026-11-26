import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadQuestionsWorkspace } from "../../state/threadQuestions";
import { threadTaskElementId } from "../questions/questionReveal";
import { ThreadTaskCard } from "./ThreadTaskCard";

/** The cards of the user tasks one `list_update` or `list_rewrite` call filed, at the call. */
export function ThreadTasksTimelineRow({
  threadRef,
  taskRefs,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly taskRefs: ReadonlyArray<string>;
}) {
  const { workspace, error } = useThreadQuestionsWorkspace(threadRef, true);
  return (
    <div className="flex min-w-0 flex-col gap-2 px-1 py-0.5">
      {taskRefs.map((ref) => {
        const task = workspace?.items.find((item) => item.owner === "you" && item.ref === ref);
        return task !== undefined && workspace ? (
          <ThreadTaskCard
            key={ref}
            threadRef={threadRef}
            task={{ ...task, ref }}
            revision={workspace.revision}
            inTimeline
          />
        ) : (
          <p
            key={ref}
            id={threadTaskElementId(ref)}
            role="status"
            className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {workspace == null ? (error ?? `Loading ${ref}…`) : `${ref} is no longer in the list.`}
          </p>
        );
      })}
    </div>
  );
}
