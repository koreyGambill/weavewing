import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { compactDynamicToolOutput, compactT3MessageInput } from "@t3tools/shared/toolOutput";

import {
  outgoingT3Message,
  outgoingT3MessageLabel,
  summarizeT3ToolCalls,
  type T3ToolSummaryCall,
} from "./t3ToolSummary.ts";

function completed(input: unknown, output?: unknown): T3ToolSummaryCall {
  return { input, output, outcome: "completed" };
}

describe("summarizeT3ToolCalls", () => {
  it.each([
    [
      "mcp__t3-code__t3_thread_send",
      { threadId: "target", message: "Hello" },
      { structuredContent: { threadId: "target" } },
    ],
    [
      "t3-code.t3_thread_send",
      JSON.stringify({ threadId: "target", message: "Hello" }),
      [{ type: "text", text: '{"threadId":"target"}' }],
    ],
    [
      "mcp__t3_code_direct__t3_thread_send",
      { threadId: "target", message: "Hello" },
      { content: [{ text: { text: '{"threadId":"target"}' } }] },
    ],
    [
      "t3-code/t3_thread_send",
      { toolName: "t3_thread_send", args: { threadId: "target", message: "Hello" } },
      '{"threadId":"target"}',
    ],
    [
      "t3-code-session_1_t3_thread_send",
      { threadId: "target", message: "Hello" },
      { threadId: "target" },
    ],
    [
      "mcp__t3-code__t3_thread_send_attachments",
      { threadId: "target", message: "Hello", attachments: [{ attachmentId: "upload" }] },
      { threadId: "target" },
    ],
  ])("extracts an outgoing message from %s", (name, input, output) => {
    for (const result of [output, compactDynamicToolOutput(output, name)]) {
      expect(outgoingT3Message(name, completed(input, result))).toMatchObject({
        threadId: "target",
        body: "Hello",
        event: "sent",
        relationship: "to peer thread",
        noReply: false,
      });
    }
  });

  it("resolves launched and delegated threads, including remote children and failed child work", () => {
    expect(
      outgoingT3Message(
        "mcp__t3-code__t3_thread_launch",
        completed({ message: "Start here", environmentId: "remote" }, { threadId: "new" }),
      ),
    ).toMatchObject({
      threadId: "new",
      environmentId: "remote",
      body: "Start here",
      noReply: true,
    });
    expect(
      outgoingT3Message(
        "t3-code.delegate_task",
        completed({ task: "Review this" }, { childThreadId: "child", status: "failed" }),
      ),
    ).toMatchObject({
      threadId: "child",
      body: "Review this",
      relationship: "delegated task",
      event: "sent",
    });
    expect(
      outgoingT3Message(
        "delegate_task",
        completed(
          { task: "Review remotely", target: { environmentId: "wrong" } },
          { childThreadId: null, remoteChild: { environmentId: "remote", threadId: "child" } },
        ),
      ),
    ).toMatchObject({ threadId: "child", environmentId: "remote" });
    for (const link of ["t3-thread://v2/linked/new", "<t3-thread://v2/linked/new>"]) {
      expect(
        outgoingT3Message(
          "t3_thread_launch",
          completed({ message: "Launch" }, { link, threadId: "new" }),
        ),
      ).toMatchObject({ threadId: "new", environmentId: "linked" });
    }
    expect(
      outgoingT3Message("t3_thread_launch", completed({ title: "Idle" }, { threadId: "idle" })),
    ).toBeNull();
    expect(
      outgoingT3Message("other.t3_thread_send", completed({ threadId: "x", message: "Hi" })),
    ).toBeNull();
  });

  it("preserves replies, queued delivery and no-reply sends without reading message JSON as metadata", () => {
    expect(
      outgoingT3Message(
        "t3_thread_send",
        completed(
          { threadId: "target", message: '{"threadId":"fake"}', reply: false },
          { delivery: "queued" },
        ),
      ),
    ).toMatchObject({
      threadId: "target",
      body: '{"threadId":"fake"}',
      noReply: true,
      event: "queued",
    });
    expect(
      outgoingT3Message(
        "t3_thread_send",
        completed({ threadId: "target", message: "Answer", origin: { event: "reply" } }),
      ),
    ).toMatchObject({ event: "reply" });
    expect(
      outgoingT3Message(
        "t3_thread_send",
        completed({ threadId: "target", message: "FYI", origin: { reply: "not expected" } }),
      ),
    ).toMatchObject({ noReply: true });
    expect(
      outgoingT3Message(
        "t3_thread_send",
        completed(
          { threadId: "target", message: "Question", origin: { reply: "not expected" } },
          { reply: true },
        ),
      ),
    ).toMatchObject({ noReply: false });
  });

  it.each([
    [{ isError: true, content: [{ type: "text", text: "Permission denied" }] }, "completed"],
    [
      [{ type: "text", text: '{"_tag":"OrchestratorMcpFailure","message":"Permission denied"}' }],
      "completed",
    ],
    [{ is_error: true, content: "Permission denied" }, "completed"],
    ["Permission denied", "failed"],
  ] as const)("keeps a failed or refused send distinct from delivery: %j", (output, outcome) => {
    const call = {
      input: { threadId: "target", message: "Hello" },
      output,
      outcome,
    };
    for (const result of [
      output,
      compactDynamicToolOutput(output, "t3_thread_send", outcome === "failed"),
    ]) {
      expect(outgoingT3Message("t3_thread_send", { ...call, output: result })).toMatchObject({
        event: "failed",
        error: "Permission denied",
        body: "Hello",
      });
    }
  });

  it("keeps unfinished calls as tool rows and failed launches without a target as failed sends", () => {
    expect(
      outgoingT3Message("t3_thread_send", {
        input: { threadId: "target", message: "Hello" },
        output: undefined,
        outcome: "unfinished",
      }),
    ).toBeNull();
    expect(
      outgoingT3Message("t3_thread_launch", {
        input: { title: "Review", message: "Hello" },
        output: "Refused",
        outcome: "failed",
      }),
    ).toMatchObject({ threadId: null, event: "failed", error: "Refused" });
  });

  it.each([
    [
      "delegate_task",
      { task: "Review" },
      { childThreadId: "child" },
      { threadId: "child", relationship: "delegated task" },
    ],
    [
      "delegate_task",
      { task: "Review" },
      { remoteChild: { threadId: "child", environmentId: "remote" } },
      { threadId: "child", environmentId: "remote" },
    ],
    [
      "t3_thread_send",
      { message: "Hello", threadId: "target" },
      { delivery: "queued", reply: false },
      { event: "queued", noReply: true },
    ],
    [
      "t3_thread_launch",
      { message: "Hello" },
      { threadId: "target", link: "<t3-thread://v2/remote/target>" },
      { threadId: "target", environmentId: "remote" },
    ],
    [
      "t3_thread_send",
      { message: "Hello", threadId: "target" },
      { isError: true, content: [{ text: "Permission denied" }] },
      { event: "failed", error: "Permission denied" },
    ],
  ])("extracts %s metadata retained on the timeline wire", (name, input, output, expected) => {
    expect(
      outgoingT3Message(name, completed(input, compactDynamicToolOutput(output, name))),
    ).toMatchObject(expected);
  });

  it.each(["t3_thread_send", "t3_thread_launch", "delegate_task"])(
    "retains a bounded message preview for oversized %s input",
    (name) => {
      const key = name === "delegate_task" ? "task" : "message";
      const input = {
        [key]: "A long message. ".repeat(2000),
        threadId: "target",
        environmentId: "remote",
        reply: false,
        origin: { event: "reply" },
      };
      for (const value of [input, JSON.stringify(input), { toolName: name, args: input }]) {
        const compact = compactT3MessageInput(name, value);
        const message = outgoingT3Message(name, completed(compact));
        expect(message).toMatchObject({
          threadId: "target",
          environmentId: "remote",
          event: "reply",
          noReply: true,
        });
        expect(message?.body).toContain("A long message.");
        expect(message?.body).toContain("Open tool details for the full message.");
        expect(JSON.stringify(compact).length).toBeLessThan(2000);
      }
    },
  );

  it("reads provider result envelopes without treating JSON in the message as result data", () => {
    const result = { messageId: "message-1", threadId: "actual-thread" };
    const json = JSON.stringify(result);
    const outputs = [
      result,
      { structuredContent: result },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ];
    const calls = outputs.map((output) =>
      completed(
        {
          toolName: "t3_thread_send",
          args: { threadId: "input-thread", message: '{"threadId":"fake"}' },
        },
        output,
      ),
    );
    expect(summarizeT3ToolCalls("thread-send", calls).label).toBe("Sent 1 message to 1 thread");
    expect(
      summarizeT3ToolCalls("thread-send", [
        completed({ toolName: "t3_thread_send", args: { threadId: "input-thread" } }),
        completed({ threadId: "input-thread" }),
      ]).label,
    ).toBe("Sent 2 messages to 1 thread");
  });

  it("counts the questions an ask created from the raw or compact result", () => {
    const raw = [{ type: "text", text: '{"ids":["Q1","Q2"]}' }];
    for (const output of [raw, compactDynamicToolOutput(raw, "question_ask")]) {
      expect(summarizeT3ToolCalls("thread-question-ask", [completed({}, output)]).label).toBe(
        "Asked 2 questions",
      );
    }
  });

  it("counts the pull requests batch link and unlink calls changed", () => {
    const urls = ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1", "not-a-pr"];
    const links = completed({ urls }, { linkedCount: 1 });
    expect(summarizeT3ToolCalls("link-pr", [links, completed({ number: 3 })]).label).toBe(
      "Linked 2 pull requests",
    );
    expect(summarizeT3ToolCalls("link-pr", [completed({ urls }, {})]).label).toBe(
      "Linked pull requests",
    );
    const batch = completed({ states: ["merged"] }, { unlinkedCount: 2 });
    expect(summarizeT3ToolCalls("unlink-pr", [batch, completed({ number: 3 })]).label).toBe(
      "Unlinked 3 pull requests",
    );
    const uncounted = completed({ states: ["merged"] }, { isError: false });
    expect(summarizeT3ToolCalls("unlink-pr", [uncounted]).label).toBe("Unlinked pull requests");
  });

  it("excludes failed and unfinished sends even if the provider reports completed", () => {
    const calls: T3ToolSummaryCall[] = [
      completed({ threadId: "success" }, { messageId: "ok", threadId: "success" }),
      completed(
        { threadId: "failed" },
        { isError: true, structuredContent: { threadId: "failed" } },
      ),
      completed({ threadId: "failed" }, [
        { type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure" }) },
      ]),
      { input: { threadId: "cancelled" }, output: undefined, outcome: "unfinished" },
    ];
    expect(summarizeT3ToolCalls("thread-send", calls)).toEqual({
      label: "Sent 1 message to 1 thread",
      failedCount: 2,
    });
    expect(summarizeT3ToolCalls("thread-send", [calls[1]!])).toEqual({
      label: "Tried to send 1 message to 1 thread",
      failedCount: 1,
    });
  });

  it("does not confuse a child's failure or wait timeout with failure of the orchestration call", () => {
    const failedChild = { taskId: "task-1", status: "failed", summary: "command not found" };
    expect(
      summarizeT3ToolCalls("delegate", [completed({}, failedChild), completed({}, failedChild)]),
    ).toEqual({
      label: "Delegated 1 task",
      failedCount: 0,
    });
    expect(
      summarizeT3ToolCalls(
        "task-status",
        Array.from({ length: 4 }, () => completed({ taskId: "task-1" }, failedChild)),
      ).label,
    ).toBe("Checked task status 4 times");
    expect(
      summarizeT3ToolCalls("thread-wait", [
        completed({ threadId: "thread-1" }, { threadId: "thread-1", timedOut: true }),
      ]),
    ).toEqual({
      label: "Waited on 1 thread",
      failedCount: 0,
    });
  });
});

describe("outgoingT3MessageLabel", () => {
  it("distinguishes the sender's child from peers and another parent's delegated task", () => {
    const source = {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("parent"),
    };
    const child = {
      delegatedFrom: null,
      lineage: {
        parentThreadId: source.threadId,
        rootThreadId: source.threadId,
        relationshipToParent: "subagent" as const,
      },
    };
    const peer = outgoingT3Message(
      "t3_thread_send",
      completed(
        { threadId: "target", message: "Follow up" },
        { threadId: "target", taskId: "follow-up" },
      ),
    );
    const delegated = outgoingT3Message(
      "delegate_task",
      completed({ task: "Review" }, { childThreadId: "child" }),
    );
    expect(peer).not.toBeNull();
    expect(delegated).not.toBeNull();
    if (peer === null || delegated === null) throw new Error("Expected outgoing messages");
    expect(outgoingT3MessageLabel(peer, source, child)).toBe("Sent to child thread");
    expect(
      outgoingT3MessageLabel(peer, { ...source, threadId: ThreadId.make("other") }, child),
    ).toBe("Sent to thread");
    expect(outgoingT3MessageLabel({ ...peer, environmentId: "remote" }, source, child)).toBe(
      "Sent to thread",
    );
    expect(
      outgoingT3MessageLabel({ ...peer, environmentId: "remote" }, source, {
        ...child,
        delegatedFrom: { ...source, title: "Parent" },
      }),
    ).toBe("Sent to child thread");
    expect(outgoingT3MessageLabel(peer, source, null)).toBe("Sent to thread");
    expect(outgoingT3MessageLabel(delegated, source, null)).toBe("Sent to child thread");
    expect(outgoingT3MessageLabel({ ...peer, event: "failed" }, source, child)).toBe(
      "Tried to send to child thread",
    );
  });
});
