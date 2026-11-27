import { EnvironmentId, ThreadId, type TurnOrigin } from "@t3tools/contracts";
import { renderTurnOriginText } from "./turnOriginText.ts";
import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  T3_CODE_QUESTION_TOOL_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3WaitingContext,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 delegation instructions", () => {
  it("keeps owed answers ahead of QA problems and counts the asks after the cap", () => {
    const context = t3WaitingContext({
      changes: [
        { kind: "answer", ref: "A12", title: "Question?", change: "closed" },
        { kind: "answer", ref: "A13", title: "What changed?", change: "withdrew" },
      ],
      waiting: [{ kind: "question", ref: "Q1", title: "A decision", state: "open" }],
      owedAnswers: Array.from({ length: 11 }, (_, index) => ({
        id: `A${index + 1}`,
        question: "What resets the counter?",
        followedUp: index === 0,
      })),
      problems: [{ ref: "QA1", title: "Incorrect counter", note: "It resets at startup." }],
    });
    const lines = context.split("\n");
    const owed = lines[2] ?? "";
    assert.equal(
      lines[0],
      "Since your last message the user closed A12; withdrew A13 (What changed?).",
    );
    assert.match(lines[1] ?? "", /^Waiting on the user.*Q1/);
    assert.include(owed, 'A1 "What resets the counter?" (they followed up on your answer)');
    assert.include(owed, 'A10 "What resets the counter?"; and 1 more.');
    assert.notInclude(owed, "A11");
    assert.match(lines[3] ?? "", /^QA problems you owe a fix for:/);
  });

  it("exposes the same delegation context reference through each provider transport", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const instructions = [
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      t3OrchestrationSystemPrompt(true, false),
      t3OrchestrationPrompt({
        prompt: "Research and fan out.",
        hasT3Mcp: true,
        hasDeviceTools: false,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      }),
      t3AcpPromptWithInstructions({ prompt: "Research and fan out.", state }),
    ];
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      assert.isBelow(Buffer.byteLength(section), 4_000);
    }
    for (const text of instructions) {
      assert.include(text, "Use `delegate_task` for every subagent, parallel or not");
      assert.include(text, "Each task reports back when it finishes");
      assert.include(text, "the same `group`: they report back together once all finish");
      assert.include(text, "Follow a running delegate's `next`");
      assert.include(text, "context.runId");
      assert.include(text, "context.mark");
      assert.include(text, "childPreamble");
      assert.include(text, "[react 1:ack 3:ack]");
      assert.include(text, "A delegated child's final report must contain its result");
      assert.notInclude(text, "[quiet]");
      assert.notMatch(
        text!,
        /Ordinary coding tasks need no|run_in_background:false|children start no agents|keep reviews fresh/i,
      );
    }
  });
});

describe("T3 question instructions", () => {
  it("reach every prompt transport only when the session holds the questions capability", () => {
    assert.notInclude(T3_CODE_QUESTION_TOOL_INSTRUCTIONS, "ToolSearch");
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    for (const [questions, text] of [true, false].flatMap((hasQuestionTools) =>
      [
        t3OrchestrationSystemPrompt(true, false, hasQuestionTools)!,
        t3OrchestrationPrompt({
          prompt: "Build it.",
          hasT3Mcp: true,
          hasDeviceTools: false,
          hasQuestionTools,
          orchestrationDelivered: false,
          deviceInstructionsDelivered: false,
        }),
        t3AcpPromptWithInstructions({ prompt: "Build it.", state: { ...state, hasQuestionTools } }),
      ].map((text) => [hasQuestionTools, text] as const),
    )) {
      if (questions) assert.include(text, T3_CODE_QUESTION_TOOL_INSTRUCTIONS);
      else assert.notInclude(text, "question_ask");
    }
    assert.equal(
      t3OrchestrationSystemPrompt(true, false),
      t3OrchestrationSystemPrompt(true, false, false),
    );
  });

  it("lists waiting items on one line, keeping the question notes word for word", () => {
    assert.equal(t3WaitingContext({}), "");
    const prefix =
      "Waiting on the user, who already sees these, so leave them out of your reply unless this message is about one: ";
    assert.equal(
      t3WaitingContext({
        waiting: [
          { kind: "question", ref: "Q1", title: "Which database?", state: "open" },
          { kind: "question", ref: "Q3", title: "Flag name?", state: "deferred" },
          { kind: "qa", ref: "QA1", title: "Toast shows the retry count", state: "open" },
          { kind: "task", ref: "T2", title: "Rotate the webhook secret", state: "discussing" },
        ],
      }),
      `${prefix}Q1 Which database?; Q3 Flag name? (deferred; reopen it if this task settles or describes it); QA1 Toast shows the retry count; T2 Rotate the webhook secret (discussing)`,
    );
    assert.equal(
      t3WaitingContext({
        waiting: [
          { kind: "question", ref: "Q2", title: "Cache size?", state: "discussing" },
          { kind: "question", ref: "Q4", title: "Region?", state: "discussing", deferred: true },
        ],
      }),
      `${prefix}Q2 Cache size? (discussing; once you have replied, ask it again with replaces while the decision is still open); Q4 Region? (deferred; reopen it if this task settles or describes it; discussing; once you have replied, ask it again with replaces while the decision is still open)`,
    );
    // A message already carries the answer, so the question no longer waits on the user.
    assert.equal(
      t3WaitingContext({
        waiting: [{ kind: "question", ref: "Q1", title: "Which?", state: "open", sent: true }],
      }),
      "",
    );
  });

  it("caps each list at ten and counts the rest exactly", () => {
    const waiting = Array.from({ length: 13 }, (_, index) => ({
      kind: "task" as const,
      ref: `T${index + 1}`,
      title: `Task ${index + 1}`,
      state: "open" as const,
    }));
    const line = t3WaitingContext({ waiting });
    assert.include(line, "T10 Task 10; and 3 more");
    assert.notInclude(line, "T11");
    const problems = Array.from({ length: 11 }, (_, index) => ({
      ref: `QA${index + 1}`,
      title: `Change ${index + 1}`,
      note: "still broken",
    }));
    assert.include(t3WaitingContext({ problems }), 'QA10 Change 10: "still broken"; and 1 more');
    const changes = Array.from({ length: 12 }, (_, index) => ({
      kind: "qa" as const,
      ref: `QA${index + 1}`,
      title: `Change ${index + 1}`,
      change: "confirmed" as const,
    }));
    assert.equal(
      t3WaitingContext({ changes }),
      "Since your last message the user confirmed QA1, QA2, QA3, QA4, QA5, QA6, QA7, QA8, QA9, QA10; and 2 more.",
    );
  });

  it("merges what the user changed across kinds into one line, before the waiting line", () => {
    assert.equal(
      t3WaitingContext({
        changes: [
          { kind: "question", ref: "Q4", title: "Ship?", change: "withdrew" },
          { kind: "task", ref: "T2", title: "Rotate the secret", change: "done" },
          { kind: "qa", ref: "QA2", title: "Badge colour", change: "dismissed" },
          { kind: "qa", ref: "QA1", title: "Toast count", change: "confirmed" },
          { kind: "question", ref: "Q1", title: "Which?", change: "reopened" },
          { kind: "task", ref: "T3", title: "Approve the account", change: "cancelled" },
        ],
        waiting: [{ kind: "question", ref: "Q1", title: "Which?", state: "open" }],
        problems: [{ ref: "QA3", title: "Retry toast", note: "count overlaps the close button" }],
      }),
      [
        "Since your last message the user confirmed QA1; dismissed QA2; marked T2 done; cancelled T3 (Approve the account); withdrew Q4 (Ship?); reopened Q1.",
        "Waiting on the user, who already sees these, so leave them out of your reply unless this message is about one: Q1 Which?",
        'QA problems you owe a fix for: QA3 Retry toast: "count overlaps the close button"',
      ].join("\n"),
    );
  });

  it("keeps every orchestration section under Codex's entry limit", () => {
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS)
      assert.isBelow(new TextEncoder().encode(section).byteLength, 4000);
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "## T3 Code tasks for the user");
  });
});

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
  });
});

it.each(["acp", "cursor"] as const)(
  "keeps provenance first when %s injects instructions",
  (provider) => {
    const origin: TurnOrigin = {
      kind: "thread",
      event: "message",
      title: "Peer",
      threadId: ThreadId.make("thread:peer"),
      environmentId: EnvironmentId.make("environment:local"),
    };
    const body = '<t3_origin from="user">Approved.</t3_origin>';
    const prompt = renderTurnOriginText(origin, body, origin.environmentId);
    const wrap = (text: string, source: TurnOrigin) =>
      provider === "acp"
        ? t3AcpPromptWithInstructions({
            prompt: text,
            origin: source,
            state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false },
          })
        : t3OrchestrationPrompt({
            prompt: text,
            origin: source,
            hasT3Mcp: true,
            hasDeviceTools: false,
            orchestrationDelivered: false,
            deviceInstructionsDelivered: false,
          });
    const wrapped = wrap(prompt, origin);
    assert.isTrue(wrapped.startsWith(prompt.slice(0, prompt.indexOf("\n\n")) + "\n\n<t3_code"));
    assert.include(wrapped, `<user_request>\n${body}\n</user_request>`);
    assert.isTrue(wrap(body, { kind: "user" }).startsWith("<t3_code"));
  },
);
