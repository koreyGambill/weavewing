import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexSettings,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexError from "effect-codex-app-server/errors";
import type * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexAdapterV2 from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const settings = Schema.decodeSync(CodexSettings)({});
const modelSelection = { instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" };
const threadId = ThreadId.make("thread:codex-context-rewind");
const projectId = ProjectId.make("project:codex-context-rewind");
const nativeThreadId = "codex-rewind-native-thread";
const summary = "SUP-1047 belongs to Imani Okafor.";
const prompt = "Find the checkout tickets in this screenshot, then write owners.md.";
const steered = "Also check SUP-1163.";
const lateSteer = "Then summarize the owners.";
// A one-pixel PNG.
const imageBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
);
const attachment: ChatAttachment = {
  type: "image",
  id: "thread-codex-context-rewind-6f2a3c4e-1b5d-4e7f-8a9b-0c1d2e3f4a5b-png",
  name: "tickets.png",
  mimeType: "image/png",
  sizeBytes: imageBytes.byteLength,
};

const codexTurn = (id: string, status: "inProgress" | "completed" | "interrupted") => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "inProgress" ? null : 1782622450,
  durationMs: null,
});

const codexThread = {
  thread: {
    id: nativeThreadId,
    sessionId: nativeThreadId,
    projectId: null,
    forkedFromId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1782622440,
    updatedAt: 1782622440,
    status: { type: "idle" },
    path: `/tmp/${nativeThreadId}.jsonl`,
    cwd: "/workspace",
    cliVersion: "0.171.0",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  },
  model: "gpt-5.4",
  modelProvider: "openai",
  serviceTier: null,
  cwd: "/workspace",
  instructionSources: [],
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "dangerFullAccess" },
  reasoningEffort: "medium",
};

interface CodexRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * An app-server that answers every request at once and starts the turns it is asked for. The
 * test sends the turn's items itself, so it decides when the rewind call completes.
 */
const makeScriptedCodex = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const emit = (frame: unknown) =>
    Queue.offer(inbound, encoder.encode(`${JSON.stringify(frame)}\n`));
  const notify = (method: string, params: unknown) => emit({ method, params });
  const requests: Array<CodexRequest> = [];
  const turnIds: Array<string> = [];
  const answer = (request: CodexRequest): unknown => {
    switch (request.method) {
      case "initialize":
        return {
          userAgent: "T3 Code/0.171.0",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        };
      case "thread/start":
      case "thread/resume":
      case "thread/revert":
        return codexThread;
      case "thread/read":
        return { ...codexThread, thread: { ...codexThread.thread, historyMode: "paginated" } };
      case "config/read":
        return { config: {}, origins: {} };
      case "turn/start":
        turnIds.push(`turn-${turnIds.length + 1}`);
        return { turn: codexTurn(turnIds.at(-1)!, "inProgress") };
      case "turn/steer":
        return { turnId: turnIds.at(-1) };
      case "thread/turns/list":
        return {
          data: [{ id: turnIds.at(-1), items: [], status: "interrupted", error: null }],
          nextCursor: null,
        };
      case "thread/backgroundTerminals/list":
      case "mcpServerStatus/list":
        return { data: [], nextCursor: null };
      default:
        return {};
    }
  };
  let pending = "";
  const client = yield* CodexClient.make(
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(inbound),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.gen(function* () {
            pending += typeof chunk === "string" ? chunk : decoder.decode(chunk);
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines.filter((candidate) => candidate.length > 0)) {
              const frame = JSON.parse(line) as {
                readonly id?: number;
                readonly method?: string;
                readonly params?: Record<string, unknown>;
              };
              if (frame.id === undefined || frame.method === undefined) continue;
              const request = { method: frame.method, params: frame.params ?? {} };
              requests.push(request);
              yield* emit({ id: frame.id, result: answer(request) });
              if (request.method === "turn/start") {
                yield* notify("turn/started", {
                  threadId: nativeThreadId,
                  turn: codexTurn(turnIds.at(-1)!, "inProgress"),
                });
              }
              if (request.method === "turn/interrupt") {
                yield* notify("turn/completed", {
                  threadId: nativeThreadId,
                  turn: codexTurn(String(request.params.turnId), "interrupted"),
                });
              }
            }
          }),
        ),
      stderr: () => Sink.drain,
    }),
    {},
    Effect.succeed(new CodexError.CodexAppServerProcessExitedError({ code: 0, pid: 1 })),
  );
  const completeItem = (turnId: string, item: Record<string, unknown>) =>
    notify("item/completed", {
      threadId: nativeThreadId,
      turnId,
      completedAtMs: 1782622445010,
      item,
    });
  return { client, requests, turnIds, completeItem };
});

const runRewindScenario = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* checkpointWorkspace("codex-context-rewind");
  const serverConfig = yield* ProviderReplayHarness.makeReplayServerConfig(
    "codex-context-rewind",
  ).pipe(Effect.orDie);
  const imagePath = resolveAttachmentPath({
    attachmentsDir: serverConfig.attachmentsDir,
    attachment,
  })!;
  yield* fileSystem.makeDirectory(serverConfig.attachmentsDir, { recursive: true });
  yield* fileSystem.writeFile(imagePath, imageBytes);
  const codex = yield* makeScriptedCodex;
  const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
    instanceId: modelSelection.instanceId,
    settings,
    environment: {},
    clientFactory: { open: () => Effect.succeed(codex.client) },
    digest: yield* Digest.Digest,
    fileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig,
  });
  return yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threads = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        ThreadManagementService.layer.pipe(
          Layer.provide(ServerSettings.layerTest()),
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
    const dispatchMessage = (input: {
      readonly id: string;
      readonly text: string;
      readonly dispatchMode: Extract<
        Orchestrator.OrchestratorV2Command,
        { readonly type: "message.dispatch" }
      >["dispatchMode"];
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    }) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        origin: { kind: "user" },
        commandId: CommandId.make(input.id),
        threadId,
        messageId: MessageId.make(input.id),
        text: input.text,
        attachments: input.attachments ?? [],
        dispatchMode: input.dispatchMode,
        createdBy: "user",
        creationSource: "web",
      });

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId,
      title: "Codex context rewind",
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
    yield* dispatchMessage({
      id: "first",
      text: prompt,
      attachments: [attachment],
      dispatchMode: { type: "start_immediately" },
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    const rewoundTurn = codex.turnIds[0]!;

    const looked = yield* watch(
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "command_execution" &&
        event.payload.status === "completed",
    );
    yield* codex.completeItem(rewoundTurn, {
      type: "commandExecution",
      id: "lookup",
      command: "cat tickets.txt",
      cwd: "/workspace",
      processId: "42",
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "cat tickets.txt" }],
      aggregatedOutput: "x".repeat(70_000),
      exitCode: 0,
      durationMs: 10,
    });
    yield* Fiber.join(looked);

    // A steer that reaches the turn before the rewind belongs to the message the rewind resends.
    const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    yield* dispatchMessage({
      id: "steer",
      text: steered,
      dispatchMode: { type: "steer_active", targetRunId: parent.id },
    });
    yield* worker.drain();

    const rewound = yield* threads.rewindContext({ threadId, summary }).pipe(Effect.result);

    // A steer after the rewind would be dropped with the turn, so it queues behind the continuation.
    yield* dispatchMessage({
      id: "late",
      text: lateSteer,
      dispatchMode: { type: "steer_active", targetRunId: parent.id },
    });
    yield* worker.drain();
    const queued = yield* orchestrator.getThreadProjection(threadId);

    const parentEnded = yield* watch(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === parent.id &&
        event.payload.status !== "running" &&
        event.payload.status !== "starting",
    );
    yield* codex.completeItem(rewoundTurn, {
      type: "mcpToolCall",
      id: "rewind-call",
      server: "t3-code-direct",
      tool: "context_rewind_turn",
      status: "completed",
      arguments: { summary },
      result: { content: [{ type: "text", text: "End your turn now." }] },
    });
    yield* Fiber.join(parentEnded);
    yield* worker.drain();
    const continuationStarted = yield* watch(
      (event) =>
        event.type === "provider-turn.updated" &&
        event.payload.status === "running" &&
        event.payload.nativeTurnRef?.nativeId === "turn-2",
    );
    yield* orchestrator.resumeQueuedRuns;
    yield* worker.drain();
    yield* Fiber.join(continuationStarted);
    const after = yield* orchestrator.getThreadProjection(threadId);
    return { rewound, queued, after, parent, requests: codex.requests, rewoundTurn };
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "codex-context-rewind" },
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
  "reverts the rewound Codex turn and resends its message, image and steer before the summary",
  () =>
    Effect.gen(function* () {
      const { rewound, queued, after, parent, requests, rewoundTurn } = yield* runRewindScenario;
      assert.equal(rewound._tag, "Success");

      // The late steer was declined and queued behind the continuation, each in its own run.
      const continuation = queued.runs.find((run) =>
        queued.messages.some(
          (message) => message.id === run.userMessageId && message.origin?.kind === "system",
        ),
      );
      const late = queued.runs.find((run) => run.userMessageId === MessageId.make("late"));
      assert.equal(continuation?.status, "queued");
      assert.equal(late?.status, "queued");
      assert.isBelow(continuation!.ordinal, late!.ordinal);

      // The adapter's own interrupt ends a run the user never stopped.
      assert.equal(after.runs.find((run) => run.id === parent.id)?.status, "completed");

      const methods = requests.map((request) => request.method);
      const revert = requests.find((request) => request.method === "thread/revert");
      assert.deepEqual(revert?.params, { threadId: nativeThreadId, beforeTurnId: rewoundTurn });
      const starts = requests.filter((request) => request.method === "turn/start");
      assert.lengthOf(starts, 2);
      assert.isBelow(methods.indexOf("thread/revert"), methods.lastIndexOf("turn/start"));

      const sent = starts[0]!.params.input as ReadonlyArray<Record<string, unknown>>;
      const resent = starts[1]!.params.input as ReadonlyArray<Record<string, unknown>>;
      // The original message, its image and the steer come first, exactly as Codex received them.
      assert.deepEqual(resent.slice(0, sent.length), sent);
      assert.include(String(sent[0]?.text), prompt);
      assert.deepEqual(sent[1], {
        type: "image",
        url: `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`,
      });
      assert.deepEqual(resent[sent.length], { type: "text", text: steered });
      const note = String(resent.at(-1)?.text);
      assert.include(note, "You already worked on the message above");
      assert.include(note, summary);
      assert.lengthOf(resent, sent.length + 2);
      assert.notInclude(JSON.stringify(resent), lateSteer);
    }),
);
