import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { T3_CODE_ORCHESTRATION_SECTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as Footprints from "./InstructionFootprints.ts";

it("extracts complete child preambles and ignores an unclosed remainder", () => {
  expect(
    Footprints.childPreambleEntries(
      '<child_preamble source="parent thread Workspace">Use fixtures.\nReport friction.</child_preamble>\nTask.\n<child_preamble></child_preamble>\n' +
        "<child_preamble>unclosed\n".repeat(10_000),
    ),
  ).toEqual([
    { key: "workspace_child_preamble", text: "Use fixtures.\nReport friction." },
    { key: "workspace_child_preamble", text: "" },
  ]);
  expect(Footprints.childPreambleEntries("<child_preamble".repeat(10_000))).toEqual([]);
});

it("files the QA section under QA and counts an update notice as its own part", () => {
  const orchestration = T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n");
  const qa = T3_CODE_ORCHESTRATION_SECTIONS.find((section) => section.startsWith("## T3 Code QA"))!;
  const notice = `<system-reminder>\n<section name="## T3 Code QA" change="added">\n${qa}\n</section>\n</system-reminder>`;
  const parts = Footprints.splitPreparedContext([
    { key: "t3_code_orchestration", text: orchestration },
    { key: "t3_update_notice", text: notice },
  ]);
  expect(parts.find((part) => part.label === "QA")?.bytes).toBe(Buffer.byteLength(qa));
  expect(parts.find((part) => part.label === "Threads and environments")?.text).not.toContain(
    "## T3 Code QA",
  );
  expect(parts.find((part) => part.label === "Instruction update notice")?.bytes).toBe(
    Buffer.byteLength(notice),
  );
  expect(parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(
    Buffer.byteLength(orchestration + notice),
  );
});

it.effect(
  "persists measured payload sizes without prompt text and scopes snapshots by thread, run, and attempt",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "instruction-footprints-test-" });
      const configContext = yield* Layer.build(ServerConfig.layerTest(root, root));
      const config = Context.get(configContext, ServerConfig.ServerConfig);
      const open = Effect.fn("test.openFootprints")(function* () {
        const context = yield* Layer.build(
          Layer.fresh(Footprints.layer).pipe(
            Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
          ),
        );
        return Context.get(context, Footprints.InstructionFootprints);
      });
      const service = yield* open();
      const threadId = ThreadId.make("thread/../../safe");
      const runId = RunId.make("run/../../safe");
      const source = path.join(root, "AGENTS.md");
      yield* fs.writeFileString(source, "source instructions");
      const secretText = "Private custom instructions 🔒";
      const orchestration = T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n");
      const entries = [
        { key: "t3_code_orchestration", text: orchestration },
        { key: "custom_claude_append", text: secretText },
      ];
      yield* service.record({
        threadId,
        runId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        model: "test",
        providerTurnOrdinal: 1,
        attemptId: "attempt/one",
        source: "actual test payload",
        injectedTools: ["t3_context_read", "list_read"],
        instructionSources: [source],
        entries,
      });
      yield* service.record({
        threadId,
        runId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        model: "test",
        providerTurnOrdinal: 1,
        attemptId: "attempt/two",
        source: "actual test payload",
        injectedTools: Array.from({ length: 300 }, (_, index) => `tool-${index}`),
        instructionSources: [source],
        entries,
      });
      yield* service.record({
        threadId,
        runId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        model: "test",
        providerTurnOrdinal: 1,
        attemptId: "attempt/sources-only",
        source: "actual test payload",
        instructionSources: Array.from({ length: 65 }, () => source),
        entries,
        sizedEntries: [
          { key: "t3:earlier-copy", label: "Earlier copy of ## T3 Code QA", bytes: 700 },
        ],
      });
      const reopened = yield* open();
      const saved = yield* reopened.list(threadId, runId);
      expect(saved).toHaveLength(3);
      expect(saved.find((item) => item.attemptId === "attempt/sources-only")).toMatchObject({
        truncated: true,
      });
      expect(
        saved.find((item) => item.attemptId === "attempt/sources-only")?.instructionSources,
      ).toHaveLength(64);
      expect(saved.find((item) => item.attemptId === "attempt/sources-only")?.parts).toContainEqual(
        {
          key: "t3:earlier-copy",
          label: "Earlier copy of ## T3 Code QA",
          category: "t3",
          bytes: 700,
          estimatedTokens: 175,
        },
      );
      expect(saved.find((item) => item.attemptId === "attempt/one")?.injectedTools).toEqual([
        "t3_context_read",
        "list_read",
      ]);
      expect(saved.find((item) => item.attemptId === "attempt/two")).toMatchObject({
        injectedToolCount: 300,
        truncated: true,
      });
      expect(saved.find((item) => item.attemptId === "attempt/two")?.injectedTools).toHaveLength(
        256,
      );
      expect(saved[0]?.instructionSources).toEqual([{ path: source, bytes: 19 }]);
      expect(saved[0]?.parts.reduce((sum, part) => sum + part.bytes, 0)).toBe(
        Buffer.byteLength(orchestration + secretText),
      );
      expect(saved[0]?.parts.some((part) => part.label === "Thread list and artifacts")).toBe(true);
      expect(saved[0]?.parts.filter((part) => part.category === "custom")).toMatchObject([
        { bytes: Buffer.byteLength(secretText) },
      ]);
      expect(
        new Set(saved[0]?.parts.map((part) => `${part.category}:${part.key}:${part.label}`)).size,
      ).toBe(saved[0]?.parts.length);
      expect(yield* reopened.list(threadId, RunId.make("other"))).toEqual([]);
      expect(yield* reopened.list(ThreadId.make("other"), null)).toEqual([]);
      expect(yield* reopened.list(threadId, null)).toHaveLength(3);
      const directory = path.join(config.stateDir, "instruction-footprints");
      const directories = yield* fs.readDirectory(directory);
      expect(directories).toHaveLength(1);
      const files = yield* fs.readDirectory(path.join(directory, directories[0]!));
      const file = path.join(directory, directories[0]!, files[0]!);
      const contents = yield* fs.readFileString(file);
      expect(contents).not.toContain(secretText);
      expect(contents).not.toContain("Workspace is an intentional scratchboard");
      yield* fs.writeFileString(file, "{malformed");
      expect(yield* Effect.result(reopened.list(threadId, null))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ThreadInsightsError" },
      });
      expect(yield* fs.readFileString(file)).toBe("{malformed");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
