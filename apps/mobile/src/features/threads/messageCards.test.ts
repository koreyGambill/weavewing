import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type TurnOrigin,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { buildMessageRows } from "@t3tools/client-runtime/state/message-reactions";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadFeedMessage } from "../../lib/threadActivity";
import {
  createMessageReactionReader,
  incomingMessageCard,
  senderCardRowLabel,
  threadCardReachable,
} from "./messageCards";

vi.mock("@t3tools/client-runtime/state/message-reactions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@t3tools/client-runtime/state/message-reactions")>();
  return { ...actual, buildMessageRows: vi.fn(actual.buildMessageRows) };
});

const now = DateTime.makeUnsafe("2026-11-11T00:00:00.000Z");
const threadId = ThreadId.make("recipient");
const run = {
  id: RunId.make("run"),
  rootNodeId: NodeId.make("root"),
  userMessageId: MessageId.make("incoming"),
  status: "completed" as const,
};
const sender = {
  kind: "thread",
  event: "message",
  title: "Sender",
  threadId: ThreadId.make("sender"),
  environmentId: EnvironmentId.make("local"),
} satisfies TurnOrigin;

function base(id: string, ordinal: number) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId: run.id,
    nodeId: run.rootNodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

function userItem(origin?: TurnOrigin, summary?: string) {
  return {
    ...base("incoming", 0),
    type: "user_message",
    messageId: MessageId.make("incoming"),
    text: "Status update\nMore detail",
    inputIntent: "turn_start",
    createdBy: "agent",
    creationSource: "server",
    attachments: [],
    ...(origin ? { origin } : {}),
    ...(summary ? { summary } : {}),
  } satisfies OrchestrationV2TurnItem;
}

function assistantItem(text: string, streaming = false) {
  return {
    ...base("reply", 1),
    type: "assistant_message",
    messageId: MessageId.make("reply"),
    text,
    streaming,
  } satisfies OrchestrationV2TurnItem;
}

function projected(item: OrchestrationV2TurnItem, position: number) {
  return {
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  } satisfies OrchestrationV2ProjectedTurnItem;
}

function feedMessage(
  item: OrchestrationV2TurnItem,
  extra: Partial<ThreadFeedMessage> = {},
): ThreadFeedMessage {
  return {
    id: MessageId.make("incoming"),
    role: item.type === "assistant_message" ? "assistant" : "user",
    text: "Status update\nMore detail",
    attachments: [],
    runId: run.id,
    streaming: false,
    createdBy: "agent",
    creationSource: "server",
    visibility: "local",
    sourceThreadId: threadId,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    projectedItem: projected(item, 0),
    ...extra,
  };
}

describe("incomingMessageCard", () => {
  it("reads the structured origin and summary from the projected turn item", () => {
    expect(incomingMessageCard(feedMessage(userItem(sender, "One line")))).toEqual({
      origin: sender,
      summary: "One line",
    });
  });

  it("names a linked environment's sender when the server sent no origin", () => {
    const linkedSender = {
      environmentId: EnvironmentId.make("linked"),
      threadId: ThreadId.make("remote"),
      title: "Remote",
    };
    expect(incomingMessageCard(feedMessage(userItem(), { linkedSender }))).toMatchObject({
      origin: { kind: "thread", ...linkedSender },
    });
  });

  it.each([
    ["the user's own message", userItem({ kind: "user" })],
    ["an agent message from a server without origins", userItem()],
    ["an assistant message", assistantItem("Done")],
  ])("leaves %s to the upstream rows", (_name, item) => {
    expect(incomingMessageCard(feedMessage(item))).toBeNull();
  });
});

describe("threadCardReachable", () => {
  it.each([
    [{ phase: "connected", shellKnown: true, lookupFound: false }, true],
    [{ phase: "connected", shellKnown: false, lookupFound: true }, true],
    [{ phase: "connected", shellKnown: false, lookupFound: false }, false],
    [{ phase: "offline", shellKnown: true, lookupFound: true }, false],
    [{ phase: "reconnecting", shellKnown: true, lookupFound: false }, false],
    [{ phase: "available", shellKnown: true, lookupFound: false }, false],
    [{ phase: null, shellKnown: false, lookupFound: false }, false],
  ] as const)("opens %o: %s", (input, reachable) => {
    expect(threadCardReachable(input)).toBe(reachable);
  });
});

describe("senderCardRowLabel", () => {
  it.each([
    ["Reply from child thread", true, false, "Reply"],
    ["Failure report from child thread", true, false, "Failure report"],
    ["Message from thread", true, true, "Message from thread"],
    ["Wake", false, false, "Wake"],
    ["Weavewing · idle compaction", false, false, "Weavewing · idle compaction"],
  ])("shows %s (named %s, wide %s) as %s", (label, named, wide, shown) => {
    expect(senderCardRowLabel(label, named, wide)).toBe(shown);
  });
});

describe("createMessageReactionReader", () => {
  it("maps each incoming message to its reaction and keeps it while text streams", () => {
    const read = createMessageReactionReader();
    const runs = [run];
    const nodes: [] = [];
    const incoming = projected(userItem(sender), 0);
    const before = read(runs, nodes, [incoming, projected(assistantItem("Working", true), 1)]);
    expect(before.size).toBe(0);
    const derivations = vi.mocked(buildMessageRows).mock.calls.length;
    const streamed = read(runs, nodes, [incoming, projected(assistantItem("Working on", true), 1)]);
    expect(streamed).toBe(before);
    expect(vi.mocked(buildMessageRows).mock.calls.length).toBe(derivations);

    const settled = read(runs, nodes, [incoming, projected(assistantItem("[react 1:ack]"), 1)]);
    expect(settled.get(MessageId.make("incoming"))).toMatchObject({
      kind: "ack",
      label: "Handled",
    });
    const sameReactions = read(
      [{ ...run }],
      [],
      [incoming, projected(assistantItem("[react 1:ack]"), 1)],
    );
    expect(sameReactions).toBe(settled);
  });
});
