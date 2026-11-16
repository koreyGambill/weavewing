import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { incomingCardSummarySource } from "./incomingCardSummary.ts";

const now = DateTime.makeUnsafe(0);
const long = "Line one\nLine two";
const message = (
  overrides: Partial<OrchestrationV2ConversationMessage>,
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make("message:card"),
  threadId: ThreadId.make("thread:lead"),
  runId: null,
  nodeId: null,
  role: "user",
  text: long,
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "server",
  createdAt: now,
  updatedAt: now,
  origin: {
    kind: "thread",
    event: "message",
    title: "Ops",
    threadId: ThreadId.make("thread:ops"),
    environmentId: EnvironmentId.make("environment:local"),
  },
  ...overrides,
});

describe("incomingCardSummarySource", () => {
  it.each([
    ["a thread send", {}, 'Message from another agent\'s thread "Ops"'],
    [
      "a failure report",
      {
        origin: {
          kind: "subagent",
          event: "failed",
          title: "Build",
          threadId: ThreadId.make("thread:child"),
          environmentId: EnvironmentId.make("environment:local"),
        },
      },
      'Failure report from delegated task "Build"',
    ],
    ["the user's own message", { origin: { kind: "user" } }, null],
    ["an assistant message", { role: "assistant" }, null],
    ["a one-line message the row already shows", { text: "Done: gate green." }, null],
    ["a streaming message", { streaming: true }, null],
    ["a summarized message", { summary: "Done" }, null],
    [
      "a notification, which has its own row label",
      {
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary: "T3 Code restarted",
        },
      },
      null,
    ],
  ] as const)("%s", (_name, overrides, source) => {
    expect(
      incomingCardSummarySource(message(overrides as Partial<OrchestrationV2ConversationMessage>)),
    ).toBe(source);
  });
});
