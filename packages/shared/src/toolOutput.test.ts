import { describe, expect, it } from "vite-plus/test";

import {
  compactDynamicToolOutput,
  evidenceLandingIdFromToolItem,
  filedTasksFromToolItem,
  MAX_TOOL_OUTPUT_IMAGES,
  mcpToolResultOutput,
  questionIdsFromToolItem,
  SEND_TO_USER_MAX_LENGTH,
  sentMessageFromToolItem,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "./toolOutput.ts";

describe("compactDynamicToolOutput", () => {
  it("extracts IDs through the MCP result envelopes used by T3 summaries", () => {
    const metadata = { threadId: "thread-1", messageId: "message-1", replyToMessageId: "input-1" };
    const json = JSON.stringify({ ...metadata, response: "Private response body" });
    for (const value of [
      { ...metadata, response: "Private response body" },
      { structuredContent: JSON.parse(json), content: "Ignored alternative body" },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual(metadata);
    }
  });

  it("keeps a send_to_user message up to its limit, even in 3-byte characters", () => {
    const longest = "界".repeat(SEND_TO_USER_MAX_LENGTH);
    for (const sentMessage of ["Draft:\n\n> Hi Sam,", longest]) {
      const json = JSON.stringify({ sentMessage, message: "Shown to the user." });
      expect(compactDynamicToolOutput([{ type: "text", text: json }])).toEqual({ sentMessage });
    }
    expect(compactDynamicToolOutput({ sentMessage: `${longest}界` })).toBeUndefined();
    // OpenCode 2 Code Mode reports a script's nested send_to_user call as one `execute` item.
    const output = JSON.stringify({ sentMessage: "Draft", message: "Shown to the user." });
    expect(sentMessageFromToolItem({ toolName: "execute", output })).toBe("Draft");
  });

  it("keeps the ids question_ask assigned so the card can sit at the call", () => {
    const output = [{ type: "text", text: JSON.stringify({ ids: ["Q3", "Q4"] }) }];
    const compact = compactDynamicToolOutput(output, "mcp__t3-code__question_ask");
    expect(compact).toEqual({ questionIds: ["Q3", "Q4"] });
    // Clients read the wire's compact form again without the tool name.
    expect(
      questionIdsFromToolItem({ toolName: "mcp__t3-code__question_ask", output: compact }),
    ).toEqual(["Q3", "Q4"]);
    expect(compactDynamicToolOutput(output, "some_other_tool")).toBeUndefined();
    expect(questionIdsFromToolItem({ toolName: "send_to_user", output: compact })).toEqual([]);
    expect(
      compactDynamicToolOutput({ ids: ["Q1", "not a question"] }, "question_ask"),
    ).toBeUndefined();
  });

  it("keeps the landing evidence_record stored so its QA cards can sit at the call", () => {
    const result = { landingId: "2026-11-25-toast", changes: [{ id: "toast", qa: "pending" }] };
    const output = [{ type: "text", text: JSON.stringify(result) }];
    const compact = compactDynamicToolOutput(output, "mcp__t3-code__evidence_record");
    expect(compact).toEqual({ landingId: "2026-11-25-toast" });
    expect(
      evidenceLandingIdFromToolItem({ toolName: "mcp__t3-code__evidence_record", output: compact }),
    ).toBe("2026-11-25-toast");
    expect(compactDynamicToolOutput(output, "evidence_read")).toBeUndefined();
    expect(
      evidenceLandingIdFromToolItem({
        toolName: "evidence_record",
        output: { isError: true, content: "Duplicate change id: a" },
      }),
    ).toBeUndefined();
  });

  it("keeps the user tasks a list write filed so their cards can sit at the call", () => {
    const result = { revision: 4, items: [{ id: "a", text: "Private" }], filedTasks: ["T2"] };
    const output = [{ type: "text", text: JSON.stringify(result) }];
    const compact = compactDynamicToolOutput(output, "mcp__t3-code__list_update");
    expect(compact).toEqual({ filedTasks: ["T2"] });
    expect(
      filedTasksFromToolItem({ toolName: "mcp__t3-code__list_update", output: compact }),
    ).toEqual(["T2"]);
    expect(filedTasksFromToolItem({ toolName: "list_rewrite", output: result })).toEqual(["T2"]);
    expect(compactDynamicToolOutput(output, "list_read")).toBeUndefined();
    expect(compactDynamicToolOutput({ filedTasks: ["Q1"] }, "list_update")).toBeUndefined();
    // A result past the write's limit keeps the first cards instead of losing every one.
    const many = Array.from({ length: 101 }, (_, index) => `T${index + 1}`);
    expect(
      filedTasksFromToolItem({ toolName: "list_update", output: { filedTasks: many } }),
    ).toEqual(many.slice(0, 100));
  });

  it("keeps nested thread identity and scalar task IDs without result bodies", () => {
    const output = {
      thread: { threadId: "thread-1", messages: ["Private message"] },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      status: "failed",
      summary: "A child failed; the tool itself succeeded.",
      unlinked: [{ repository: "acme/app", state: "merged", numbers: [1] }],
      unlinkedCount: 1,
      linkedCount: 2,
    };
    expect(compactDynamicToolOutput(output)).toEqual({
      thread: { threadId: "thread-1" },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      linkedCount: 2,
      unlinkedCount: 1,
    });
    expect(output.thread.messages).toEqual(["Private message"]);
  });

  it("keeps explicit envelope failure while dropping error text and arbitrary output", () => {
    for (const failure of [
      { isError: true },
      { is_error: true },
      { _tag: "OrchestratorMcpFailure" },
      { error: { message: "Private error" } },
    ]) {
      expect(
        compactDynamicToolOutput({
          ...failure,
          structuredContent: { threadId: "thread-1", error: "Private details" },
        }),
      ).toEqual({ isError: true, threadId: "thread-1" });
    }
    expect(compactDynamicToolOutput("Private plain text")).toBeUndefined();
    expect(compactDynamicToolOutput({ result: { body: "Private result" } })).toBeUndefined();
  });

  it("uses the first result data but combines explicit failure flags across content blocks", () => {
    expect(
      compactDynamicToolOutput([
        { text: JSON.stringify({ threadId: "first" }) },
        { text: JSON.stringify({ threadId: "second", isError: true, error: "Private error" }) },
      ]),
    ).toEqual({ threadId: "first", isError: true });
    expect(
      compactDynamicToolOutput([{ text: "{}" }, { text: JSON.stringify({ threadId: "second" }) }]),
    ).toBeUndefined();
  });

  it("keeps complete thread creation batches and rollback markers without row bodies", () => {
    expect(
      compactDynamicToolOutput({
        threads: [
          { threadId: "created", status: "running", messages: ["Private message"] },
          { threadId: "reverted", status: "rolled_back", error: "Private error" },
          { status: "rolled_back" },
        ],
      }),
    ).toEqual({
      threads: [
        { threadId: "created" },
        { threadId: "reverted", status: "rolled_back" },
        { status: "rolled_back" },
      ],
    });
    expect(compactDynamicToolOutput({ threadId: "reverted", status: "rolled_back" })).toEqual({
      threadId: "reverted",
      status: "rolled_back",
    });
    expect(compactDynamicToolOutput({ threads: [] })).toEqual({ threads: [] });
  });

  it("omits incomplete or oversized creation evidence instead of returning a partial count", () => {
    for (const threads of [
      [{ threadId: "known" }, { title: "No confirmed ID" }],
      Array.from({ length: 101 }, (_, index) => ({ threadId: `thread-${index}` })),
      Array.from({ length: 100 }, (_, index) => ({ threadId: `${index}`.padEnd(256, "x") })),
      [{ threadId: "x".repeat(257) }],
    ]) {
      expect(
        compactDynamicToolOutput({
          threadId: "must-not-be-counted-as-one",
          status: "rolled_back",
          taskId: "task-1",
          threads,
        }),
      ).toEqual({ taskId: "task-1" });
    }
    const normalBatch = {
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    expect(compactDynamicToolOutput(normalBatch)).toEqual(normalBatch);
    expect(
      new TextEncoder().encode(JSON.stringify(compactDynamicToolOutput(normalBatch))).byteLength,
    ).toBeLessThanOrEqual(8_192);
  });

  it("bounds parsing and envelope scanning while preserving an outer failure marker", () => {
    const oversizedJson = JSON.stringify({ threadId: "hidden", body: "😄".repeat(5_000) });
    for (const content of [
      "x".repeat(1_000_000),
      oversizedJson,
      Array.from({ length: 33 }, () => ({ text: JSON.stringify({ threadId: "hidden" }) })),
      { content: { content: { content: { content: { threadId: "too-deep" } } } } },
    ]) {
      expect(compactDynamicToolOutput({ isError: true, content })).toEqual({ isError: true });
    }
    expect(compactDynamicToolOutput({ threadId: "known", body: "x".repeat(1_000_000) })).toEqual({
      threadId: "known",
    });
  });
});

describe("toolOutputIndicatesFailure", () => {
  it("preserves the command failure phrases across shells without copying the output", () => {
    for (const text of [
      "FILE NOT FOUND",
      "No files found",
      "ENOENT",
      "No such file or directory",
      "CommandNotFoundException",
      "command not found",
      "Cannot find path 'a' because it does not exist",
      "The term 'example' is not recognized",
      "is not recognized as the name of a cmdlet",
      "A parameter cannot be found that matches parameter name",
      "<exited with exit code 2>",
      "Exited with exit code 1",
      "exit code: 127",
      "clean exit first, then ExIt CoDe: 3",
    ])
      expect(toolOutputIndicatesFailure(text)).toBe(true);
  });

  it("does not mark successful exit codes or incomplete failure phrases", () => {
    for (const text of [
      "Done",
      "exit code: 0",
      "Exited with exit code 0",
      "cannot find path",
      "is not recognized",
      "exit",
      "not found",
      "the path cannot be found",
    ]) {
      expect(toolOutputIndicatesFailure(text)).toBe(false);
    }
  });
});

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    const structuredContent = { screenshot: { mimeType: "image/png", width: 728, height: 354 } };
    const content = [text, mcpImage];
    const output = mcpToolResultOutput({ content, structuredContent });
    expect(toolOutputImages(output)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(output).toEqual({ content, structuredContent });
    expect(mcpToolResultOutput({ content: [text], structuredContent })).toBe(structuredContent);
    expect(mcpToolResultOutput({ content })).toBe(content);
    expect(mcpToolResultOutput({ content: [text], structuredContent: {} })).toEqual([text]);
    expect(mcpToolResultOutput({ content: [text], structuredContent: [] })).toEqual([text]);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });
});
