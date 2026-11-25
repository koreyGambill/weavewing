import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const sessionId = "context-rewind-session";
const settings = Schema.decodeSync(ClaudeSettings)({ contextRewind: true });
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const threadId = ThreadId.make("thread:context-rewind");
const projectId = ProjectId.make("project:context-rewind");
const summary = "SUP-1047 belongs to Imani Okafor.";

const result = (uuid: string) =>
  ({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  }) as unknown as SDKMessage;

// The prompt, a large read, and the context_rewind call that is still running.
const transcript = (promptUuid: string) =>
  [
    { uuid: promptUuid, parentUuid: null, type: "user", message: { content: "Find the tickets" } },
    { uuid: "attachment", parentUuid: promptUuid, type: "attachment" },
    {
      uuid: "read",
      parentUuid: "attachment",
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "tool_use", id: "t1", name: "Read" }] },
    },
    {
      uuid: "read-result",
      parentUuid: "read",
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(70_000) }],
      },
    },
    {
      uuid: "rewind",
      parentUuid: "read-result",
      type: "assistant",
      message: {
        id: "msg_2",
        content: [{ type: "tool_use", id: "t2", name: "mcp__t3-code__context_rewind" }],
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");

const offeredText = (message: SDKUserMessage | undefined) =>
  JSON.stringify(message?.message.content ?? "");

const runRewindScenario = (options: { readonly continuationBlocked: boolean }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* checkpointWorkspace("context-rewind");
    const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-context-rewind-" });
    const projectDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    yield* fileSystem.makeDirectory(projectDir, { recursive: true });
    const processes: Array<{
      readonly frames: Queue.Queue<SDKMessage>;
      readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
    }> = [];
    const offers: Array<SDKUserMessage> = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: modelSelection.instanceId,
      settings,
      environment: { CLAUDE_CONFIG_DIR: configDir },
      attachmentsDir: cwd,
      fileSystem,
      path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(sessionId),
        open: (input) =>
          Effect.gen(function* () {
            const frames = yield* Queue.unbounded<SDKMessage>();
            processes.push({ frames, options: input.options });
            return {
              messages: Stream.fromQueue(frames),
              offer: (message) => Effect.sync(() => void offers.push(message)),
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              renameSession: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              listPermissionRules: Effect.succeed([]),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Queue.shutdown(frames),
            };
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        subagentModel: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      // The service's dispatch checks the provider instance, so disabling it there fails delivery.
      const threads = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(
          ThreadManagementService.layer.pipe(
            Layer.provide(
              ServerSettings.layerTest(
                options.continuationBlocked
                  ? {
                      projectSettingsOverrides: {
                        [projectId]: {
                          providerInstances: { [modelSelection.instanceId]: { enabled: false } },
                        },
                      },
                    }
                  : {},
              ),
            ),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        ),
      );
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const runEnded = (runId: string) =>
        watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === runId &&
            event.payload.status === "waiting",
        );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId,
        title: "Context rewind",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const running = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        origin: { kind: "user" },
        commandId: CommandId.make("first"),
        threadId,
        messageId: MessageId.make("first"),
        text: "Find the checkout tickets, then write owners.md.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(running);
      yield* fileSystem.writeFileString(
        path.join(projectDir, `${sessionId}.jsonl`),
        transcript(offers[0]!.uuid!),
      );
      const before = yield* orchestrator.getThreadProjection(threadId);
      const rewound = yield* threads.rewindContext({ threadId, summary }).pipe(Effect.result);

      // Messages the user sends between the tool call and the continuation: one queued, one steered.
      const parent = before.runs[0]!;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        origin: { kind: "user" },
        commandId: CommandId.make("queued"),
        threadId,
        messageId: MessageId.make("queued"),
        text: "Then summarize the owners.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        origin: { kind: "user" },
        commandId: CommandId.make("late"),
        threadId,
        messageId: MessageId.make("late"),
        text: "Also check SUP-1163.",
        attachments: [],
        dispatchMode: { type: "steer_active", targetRunId: parent.id },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      const queued = yield* orchestrator.getThreadProjection(threadId);

      const parentEnded = yield* runEnded(parent.id);
      yield* Queue.offer(processes[0]!.frames, result("rewinding-done"));
      yield* Fiber.join(parentEnded);
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      return { before, rewound, queued, processes, offers, orchestrator, worker, runEnded };
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "context-rewind" },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false },
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

it.effect(
  "runs the continuation at the cut, then the message sent meanwhile, through the real queue",
  () =>
    Effect.gen(function* () {
      const { rewound, queued, processes, offers } = yield* runRewindScenario({
        continuationBlocked: false,
      });
      assert.equal(rewound._tag, "Success");
      // The steer was declined and queued behind the continuation, each in its own run.
      const continuation = queued.runs.find((run) =>
        queued.messages.some(
          (message) => message.id === run.userMessageId && message.origin?.kind === "system",
        ),
      );
      const late = queued.runs.find((run) => run.userMessageId === MessageId.make("late"));
      assert.equal(continuation?.status, "queued");
      assert.equal(late?.status, "queued");
      assert.notEqual(continuation?.id, late?.id);
      assert.isBelow(continuation!.ordinal, late!.ordinal);

      assert.lengthOf(processes, 2);
      assert.equal(processes[1]!.options.resumeSessionAt, "attachment");
      // Queued user messages are not folded into the continuation, which would lose the cut.
      const continued = offeredText(offers[1]);
      assert.include(continued, "were removed from your context");
      assert.include(continued, summary);
      assert.notInclude(continued, "Then summarize the owners.");
    }),
);

it.effect(
  "leaves the thread and the conversation unchanged when the continuation cannot be queued",
  () =>
    Effect.gen(function* () {
      const { before, rewound, queued, processes, offers } = yield* runRewindScenario({
        continuationBlocked: true,
      });
      assert.equal(rewound._tag, "Failure");
      if (rewound._tag === "Failure") assert.equal(rewound.failure.reason, "failed");
      assert.deepEqual(
        queued.messages
          .filter((message) => message.id !== "late" && message.id !== "queued")
          .map((message) => message.id),
        before.messages.map((message) => message.id),
      );
      assert.isFalse(queued.messages.some((message) => message.origin?.kind === "system"));
      // Nothing was reserved, so the steer reached the running turn and no process was reopened.
      assert.lengthOf(processes, 1);
      assert.include(offeredText(offers[1]), "Also check SUP-1163.");
    }),
);
