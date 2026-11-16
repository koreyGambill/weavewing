import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord, ProjectId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";

import { useProject, useQuietThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadGlyph } from "./ThreadGlyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type ThreadChipRecord = Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;

export function useThreadContextMetadata(
  record: ThreadChipRecord | null,
  projectId?: ProjectId | null,
) {
  const shell = useQuietThreadShell(record);
  const lookup = useEnvironmentQuery(
    record !== null && shell === null && projectId === undefined
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId: record.environmentId,
          input: { threadIds: [record.threadId] },
        })
      : null,
  );
  const metadata = record ? lookup.data?.[record.threadId] : undefined;
  return {
    shell,
    projectId: shell?.projectId ?? projectId ?? metadata?.projectId,
    title: shell?.title?.trim() || metadata?.title.trim() || record?.title || "Thread",
  };
}

export function ThreadContextChip(props: {
  record: ThreadChipRecord;
  projectId?: ProjectId | null;
  copyMarkdown?: string;
  unreadable?: boolean;
  icon?: "thread";
  onOpenThread?: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}) {
  const { environmentId, threadId } = props.record;
  const { shell, projectId, title } = useThreadContextMetadata(props.record, props.projectId);
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId }}
                draggable={false}
                onClick={(event) => {
                  if (
                    props.onOpenThread &&
                    !event.defaultPrevented &&
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    props.onOpenThread(threadId, environmentId);
                  }
                }}
              />
            }
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            {props.icon === "thread" ? (
              <ThreadGlyph
                threadId={threadId}
                seed={shell?.glyphSeed}
                className="size-[1em] self-center"
              />
            ) : project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {props.unreadable
          ? "On another machine, so this machine's agent can't read it. Remove it or switch back to send."
          : "Open thread"}
      </TooltipPopup>
    </Tooltip>
  );
}
