import { MessageReactionChip } from "./MessageReactionChip";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useState } from "react";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  type TurnOrigin,
} from "@t3tools/contracts";
import { ChevronRightIcon, MessageSquareIcon, SettingsIcon } from "lucide-react";
import { senderCardDetails } from "@t3tools/client-runtime/user-message";
import { resolveThreadGlyph } from "@t3tools/client-runtime/thread-glyphs";
import { ThreadContextChip, useThreadContextMetadata } from "../ThreadContextChip";
import { useServerConfigs } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { WorkLogRow } from "./WorkLog";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { findRevealRef } from "./markdownFindContext";

const stopRowToggle = (event: { stopPropagation: () => void }) => event.stopPropagation();

export function SenderCard(props: {
  readonly origin: Exclude<TurnOrigin, { kind: "user" }>;
  /** The thread that received the message; decides whether the sender is its child. */
  readonly threadRef: ScopedThreadRef | null;
  readonly onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
  readonly text?: string;
  readonly summary?: string | undefined;
  readonly createdAt?: string;
  readonly timestampFormat?: TimestampFormat;
  readonly queued?: boolean;
  readonly reaction?:
    | import("@t3tools/client-runtime/state/message-reactions").InputMessageReaction
    | undefined;
  readonly children: ReactNode;
}) {
  const sender = "threadId" in props.origin ? props.origin : null;
  const { shell, title } = useThreadContextMetadata(sender);
  const serverConfigs = useServerConfigs();
  const summariesOn =
    props.threadRef === null ||
    serverConfigs.get(props.threadRef.environmentId)?.settings.incomingCardSummaries !== false;
  const details = senderCardDetails(
    props.origin,
    props.text ?? "",
    props.threadRef,
    shell,
    summariesOn ? props.summary : undefined,
  );
  const name = sender ? title : details.name;
  const glyph = sender ? resolveThreadGlyph(sender.threadId, shell?.glyphSeed) : null;
  const [expanded, setExpanded] = useState(false);
  const revealRef = findRevealRef(() => setExpanded(true));
  const toggle = () => setExpanded(!expanded);
  const accent: CSSProperties = {
    borderInlineStartColor: glyph
      ? `light-dark(${glyph.lightColor}, ${glyph.color})`
      : "var(--border)",
  };
  return (
    <div className="@container/sender w-full min-w-0">
      <WorkLogRow
        role="button"
        tabIndex={0}
        aria-label={[`${details.label} ${name ?? ""}`.trim(), details.preview]
          .filter(Boolean)
          .join(": ")}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            toggle();
          }
        }}
        icon={
          // Narrow columns hide the label; the icon keeps it as a tooltip.
          <Tooltip>
            <TooltipTrigger render={<span className="flex" />}>
              {sender ? (
                <MessageSquareIcon aria-hidden className="size-4 text-icon-muted" />
              ) : (
                <SettingsIcon aria-hidden className="size-4 text-icon-muted" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{details.label}</TooltipPopup>
          </Tooltip>
        }
        label={
          // A preview with no room wraps onto the clipped second line instead of leaving a bare "· …".
          // Narrow cards keep one line and give the summary the room the label, time and sender take.
          <span className="flex h-lh min-w-0 flex-wrap content-start items-center gap-x-1 overflow-hidden text-foreground/80 @max-[24rem]/sender:flex-nowrap">
            <span className="flex min-w-0 max-w-full items-center gap-1">
              <span className="min-w-0 truncate @max-[24rem]/sender:hidden">{details.label}</span>
              {sender ? (
                <span
                  className="flex min-w-14 max-w-60 shrink-[100000] @max-[24rem]/sender:min-w-5 @max-[24rem]/sender:max-w-24"
                  onClick={stopRowToggle}
                  onKeyDown={stopRowToggle}
                >
                  <ThreadContextChip
                    record={{
                      environmentId: sender.environmentId,
                      threadId: sender.threadId,
                      title,
                    }}
                    icon="thread"
                    onOpenThread={props.onOpenThread}
                  />
                </span>
              ) : details.name ? (
                <span className="min-w-14 max-w-60 shrink-[100000] truncate @max-[24rem]/sender:min-w-5 @max-[24rem]/sender:max-w-24">
                  {details.name}
                </span>
              ) : null}
            </span>
            {details.preview ? (
              <span className="min-w-16 flex-1 basis-0 truncate text-muted-foreground @max-[24rem]/sender:min-w-[72%]">
                · {details.preview}
              </span>
            ) : null}
          </span>
        }
        trailing={
          <>
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <ChevronRightIcon
                className={cn(
                  "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                  expanded && "rotate-90",
                )}
              />
            </span>
            {props.createdAt ? (
              <TimelineRowTimestamp
                createdAt={props.createdAt}
                timestampFormat={props.timestampFormat ?? "locale"}
                alwaysVisible
                className="@max-[24rem]/sender:hidden"
              />
            ) : null}
            <MessageReactionChip reaction={props.reaction} />
          </>
        }
      />
      <div
        ref={revealRef}
        hidden={!expanded}
        data-thread-find-text="true"
        data-thread-find-fold={!expanded ? "" : undefined}
      >
        <section
          aria-label={`${details.label} ${name ?? ""}`.trim()}
          data-sender-card={props.origin.kind}
          className={cn(
            "ms-7 mt-0.5 mb-1.5 min-w-0 border-s-2 ps-3 text-sm text-foreground wrap-anywhere",
            props.queued && "border-dashed",
          )}
          style={accent}
        >
          {props.children}
        </section>
      </div>
    </div>
  );
}
