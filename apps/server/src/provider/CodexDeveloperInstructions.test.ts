import * as NodeAssert from "node:assert/strict";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_QUESTION_TOOL_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([undefined, { browser: true, device: true, questions: true }])(
      "keeps every entry within Codex's per-entry cap with tools %j",
      (availability) => {
        const context = buildCodexAdditionalContext(runtime, availability);

        for (const [key, entry] of Object.entries(context)) {
          // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
          const bytes = Buffer.byteLength(entry.value, "utf8");
          const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
          NodeAssert.ok(
            bytes <= limit,
            `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
          );
        }
      },
    );
  });
});

describe("Codex runtime context", () => {
  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes every subagent through delegates and groups only results needed together", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(
      orchestration.includes("Use `delegate_task` for every subagent, parallel or not"),
    );
    NodeAssert.ok(orchestration.includes("not native ones (Claude `Agent`, Codex `spawn_agent`)"));
    NodeAssert.ok(orchestration.includes("Each task reports back when it finishes"));
    NodeAssert.ok(orchestration.includes("the same `group`: they report back together"));
    NodeAssert.ok(orchestration.includes("Start them in one turn, then end your turn"));
    NodeAssert.ok(orchestration.includes("Follow a running delegate's `next`"));
    NodeAssert.ok(orchestration.includes("end your turn instead of waiting or polling"));
    NodeAssert.ok(orchestration.includes("On completion, use `task_status` to read results"));
    NodeAssert.ok(!orchestration.includes("run_in_background:false"));
    NodeAssert.ok(!orchestration.includes("never a background"));
    NodeAssert.doesNotMatch(
      orchestration,
      /Ordinary coding tasks need no|children start no agents|keep reviews fresh/i,
    );
    for (const field of ["context.runId", "context.mark", "childPreamble"]) {
      NodeAssert.ok(orchestration.includes(field));
    }
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});

describe("Codex device context", () => {
  it("adds the shared device block only when the session holds device access", () => {
    const tools = (device: boolean) =>
      buildCodexAdditionalContext({ model: "gpt-6.1-sol" }, { browser: true, device }).t3_code_tools
        ?.value ?? "";

    NodeAssert.ok(tools(true).includes(T3_CODE_DEVICE_TOOL_INSTRUCTIONS));
    NodeAssert.ok(!tools(true).includes("ToolSearch"));
    NodeAssert.ok(!tools(false).includes("## T3 Code devices"));
  });

  it("adds the question block only when the session holds the questions capability", () => {
    const tools = (questions: boolean) =>
      buildCodexAdditionalContext(
        { model: "gpt-6.1-sol" },
        { browser: true, device: false, questions },
      ).t3_code_tools?.value ?? "";

    NodeAssert.ok(tools(true).includes(T3_CODE_QUESTION_TOOL_INSTRUCTIONS));
    NodeAssert.ok(!tools(false).includes("question_ask"));
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}
