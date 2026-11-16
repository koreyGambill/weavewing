import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, MessageId, type TurnOrigin } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import {
  deriveTimelineMinimapItems,
  mergeUnloadedUserTurns,
  resolveTimelineMinimapPreview,
} from "./timelineMinimapItems";

describe("deriveTimelineMinimapItems", () => {
  it("only marks human input, including explicit user origins", () => {
    const at = "2026-10-01T00:00:00Z";
    const origins: Array<TurnOrigin | undefined> = [
      undefined,
      { kind: "user" },
      {
        kind: "thread",
        threadId: ThreadId.make("peer"),
        environmentId: EnvironmentId.make("local"),
        title: "Peer",
        event: "message",
      },
      {
        kind: "subagent",
        threadId: ThreadId.make("child"),
        environmentId: EnvironmentId.make("local"),
        title: "Child",
        event: "completed",
      },
      { kind: "system", event: "monitor" },
    ];
    const rows = origins.map((origin, index) => ({
      kind: "message" as const,
      id: `input-${index}`,
      createdAt: at,
      showAssistantMeta: false,
      showAssistantCopyButton: false,
      assistantCopyStreaming: false,
      message: {
        id: MessageId.make(`input-${index}`),
        role: "user" as const,
        text: "Update",
        runId: null,
        streaming: false,
        createdAt: at,
        updatedAt: at,
        ...(origin ? { origin } : {}),
      },
    }));
    expect(
      deriveTimelineMinimapItems([
        ...rows,
        {
          ...rows[1]!,
          id: "system-as-user",
          message: { ...rows[1]!.message, createdBy: "system", creationSource: "server" },
        },
        {
          ...rows[1]!,
          id: "agent-as-user",
          message: { ...rows[1]!.message, createdBy: "agent", creationSource: "server" },
        },
        {
          ...rows[0]!,
          id: "legacy-agent",
          message: { ...rows[0]!.message, createdBy: "agent", creationSource: "server" },
        },
      ]).map(({ id }) => id),
    ).toEqual(["input-0", "input-1"]);
  });

  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems([
        {
          kind: "message",
          id: "image-only",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("image-only"),
            role: "user",
            text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
      expect(items).toEqual([{ id: "image-only", rowIndex: 0, userText: "", assistantText: null }]);
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );
});

describe("mergeUnloadedUserTurns", () => {
  const turn = (id: string, text = id) => ({
    messageId: MessageId.make(id),
    createdAt: "2026-10-01T00:00:00Z",
    text,
    replyText: `re ${id}`,
  });
  const loaded = (id: string, rowIndex: number) => ({
    id,
    rowIndex,
    userText: id,
    assistantText: null,
  });

  it("puts turns older than the loaded window above it, unloaded", () => {
    expect(
      mergeUnloadedUserTurns(
        [loaded("c", 3), loaded("d", 9)],
        [turn("a", ATTACHMENT_ONLY_BOOTSTRAP_PROMPT), turn("b"), turn("c"), turn("d"), turn("e")],
      ),
    ).toEqual([
      { id: "a", rowIndex: -1, userText: "", assistantText: "re a" },
      { id: "b", rowIndex: -1, userText: "b", assistantText: "re b" },
      loaded("c", 3),
      loaded("d", 9),
    ]);
  });

  it("keeps every server turn when none is loaded, and only loaded ones without turns", () => {
    expect(mergeUnloadedUserTurns([], [turn("a")]).map(({ id }) => id)).toEqual(["a"]);
    expect(mergeUnloadedUserTurns([loaded("x", 0)], undefined)).toEqual([loaded("x", 0)]);
  });
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: null,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
  });
});
