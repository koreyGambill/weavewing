import {
  type ChatAttachment,
  type TurnOrigin,
  type ChatFileAttachment,
  type GuestMessageAttribution,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  type OrchestrationV2LinkedSender,
  type OrchestrationV2UserMessageInputIntent,
  type ScheduledTaskId,
  type ScopedThreadRef,
  isChildThread,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "./state/shell.ts";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import { PRODUCT_NAME } from "./productName.ts";

/** The working row while the app's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly origin?: TurnOrigin | undefined;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly senderThreadId?: string | undefined;
  readonly linkedSender?: OrchestrationV2LinkedSender | undefined;
  readonly delegatedCompletion?: { readonly taskIds: ReadonlyArray<string> } | undefined;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
}): {
  readonly text: string;
  readonly sender?: Extract<TurnOrigin, { readonly threadId: unknown }>;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  // A server without structured origins still names a linked environment's sending thread.
  const origin =
    message.origin ??
    (message.linkedSender === undefined
      ? undefined
      : ({ kind: "thread", event: "message", ...message.linkedSender } satisfies TurnOrigin));
  if (origin !== undefined) {
    const sender = "threadId" in origin ? origin : undefined;
    return {
      text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
      attribution:
        origin.kind === "user"
          ? null
          : origin.kind === "scheduled-task"
            ? "automation"
            : sender
              ? "agent"
              : "t3code",
      scheduledTaskId: message.scheduledTaskId,
      ...(sender ? { sender } : {}),
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server" &&
            message.senderThreadId === undefined &&
            message.delegatedCompletion === undefined
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}

function senderOriginLabel(
  origin: Exclude<TurnOrigin, { kind: "user" }>,
  receiver: ScopedThreadRef | null,
  senderShell: Pick<EnvironmentThreadShell, "lineage" | "delegatedFrom"> | null,
): { readonly label: string; readonly name?: string } {
  switch (origin.kind) {
    case "thread": {
      const reply = origin.event === "reply" || origin.replyToMessageId !== undefined;
      const child =
        origin.relationship === "child" ||
        isChildThread(receiver, origin.environmentId, senderShell);
      return {
        label: `${reply ? "Reply" : "Message"} from ${child ? "child thread" : "thread"}`,
        name: origin.title || "Thread",
      };
    }
    case "subagent":
      return {
        label: `${origin.event === "failed" ? "Failure report" : "Report"} from child thread`,
        name: origin.title || "Agent",
      };
    case "scheduled-task":
      return { label: "Scheduled task", name: origin.title };
    case "wake":
      return { label: "Wake" };
    case "system":
      return {
        label: origin.event === "message" ? PRODUCT_NAME : `${PRODUCT_NAME} · ${origin.event}`,
      };
  }
}

/** The first nonempty line used by collapsed message summaries. */
function messageFirstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

/**
 * The collapsed row of a message another thread, task or the app sent to `receiver`.
 * A generated `summary` stands in for the first line once it arrives.
 */
export function senderCardDetails(
  origin: Exclude<TurnOrigin, { kind: "user" }>,
  text: string,
  receiver: ScopedThreadRef | null,
  senderShell: Pick<EnvironmentThreadShell, "lineage" | "delegatedFrom"> | null,
  summary?: string,
) {
  return {
    ...senderOriginLabel(origin, receiver, senderShell),
    preview: summary || messageFirstLine(text),
  };
}

export function nonUserMessageOrigin(
  message: Parameters<typeof resolveUserMessagePresentation>[0],
): Exclude<TurnOrigin, { kind: "user" }> | null {
  if (message.origin !== undefined) return message.origin.kind === "user" ? null : message.origin;
  const presentation = resolveUserMessagePresentation(message);
  if (presentation.sender !== undefined) return presentation.sender;
  return presentation.attribution === "automation"
    ? { kind: "scheduled-task", title: "Automation" }
    : presentation.attribution === "agent" || presentation.attribution === "t3code"
      ? { kind: "system", event: "message" }
      : null;
}
