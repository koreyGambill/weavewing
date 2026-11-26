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
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedMessage } from "../../lib/threadActivity";
import {
  createMessageReactionReader,
  incomingMessageCard,
  threadCardReachable,
} from "./messageCards";

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
    [{ connected: true, shellKnown: true, lookup: "pending" }, true],
    [{ connected: true, shellKnown: false, lookup: "pending" }, true],
    [{ connected: true, shellKnown: false, lookup: "found" }, true],
    [{ connected: true, shellKnown: false, lookup: "failed" }, true],
    [{ connected: true, shellKnown: false, lookup: "missing" }, false],
    [{ connected: false, shellKnown: true, lookup: "found" }, false],
  ] as const)("opens %o: %s", (input, reachable) => {
    expect(threadCardReachable(input)).toBe(reachable);
  });
});

describe("createMessageReactionReader", () => {
  it("maps each incoming message to its reaction and keeps it while text streams", () => {
    const read = createMessageReactionReader();
    const incoming = projected(userItem(sender), 0);
    const streaming = projected(assistantItem("Working", true), 1);
    const before = read([run], [], [incoming, streaming]);
    expect(before.size).toBe(0);
    const streamed = read([run], [], [incoming, projected(assistantItem("Working on", true), 1)]);
    expect(streamed).toBe(before);

    const settled = read([run], [], [incoming, projected(assistantItem("[react 1:ack]"), 1)]);
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
