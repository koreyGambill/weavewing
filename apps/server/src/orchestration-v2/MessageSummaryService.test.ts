import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  type TurnOrigin,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as MessageSummary from "./MessageSummaryService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:message-summary");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" };
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in message summary tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const report: TurnOrigin = {
  kind: "subagent",
  event: "completed",
  title: "Build BW-1",
  threadId: ThreadId.make("thread:message-summary:child"),
  environmentId: EnvironmentId.make("environment:local"),
};
const longReport = `## Result\n\n${"All checks passed on the branch and the gate is green. ".repeat(6)}`;

function makeHarness(options: {
  readonly summaries?: boolean;
  readonly dailyLimit?: number;
  readonly generate?: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateMessageSummary"]
  >;
}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "message-summary" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerSettings = ServerSettings.layerTest({
    incomingCardSummaries: options.summaries ?? true,
  });
  const layerThreads = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const generateMessageSummary = vi.fn(
    options.generate ?? (() => Effect.succeed({ summary: "Done: BW-1 gate green" })),
  );
  // A fresh service instance over the same database stands in for a server restart.
  const layerSummary = () =>
    MessageSummary.layerWithDailyLimit(options.dailyLimit ?? 10).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerSettings,
          Layer.mock(TextGeneration.TextGeneration)({ generateMessageSummary }),
        ),
      ),
    );
  const layerBase = Layer.mergeAll(
    layerThreads,
    layerDatabase,
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  );
  return {
    layer: Layer.provideMerge(layerSummary(), layerBase),
    layerBase,
    layerSummary,
    generateMessageSummary,
  };
}

const send = (threadId: ThreadId, command: string, text: string, origin: TurnOrigin) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      origin,
      commandId: CommandId.make(command),
      threadId,
      messageId: MessageId.make(`${command}:message`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: origin.kind === "user" ? "user" : "agent",
      creationSource: origin.kind === "user" ? "web" : "server",
    });
    const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
      CommandId.make(command),
    );
    return effects.flatMap((effect) =>
      effect.request.type === "message-summary.generate" ? [effect.request.messageId] : [],
    );
  });

const createThread = (name: string) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(`thread:message-summary:${name}`);
    yield* (yield* ThreadManagement.ThreadManagementService).dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:message-summary:${name}:create`),
      threadId,
      projectId,
      title: "Lead",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const readMessage = (threadId: ThreadId, messageId: MessageId) =>
  Effect.gen(function* () {
    const { messages, turnItems } =
      yield* (yield* ThreadManagement.ThreadManagementService).getThreadRecords(
        threadId,
        ["messages", "turnItems"],
        {
          messageIds: [messageId],
          turnItemTypes: ["user_message"],
        },
      );
    const item = turnItems.find(
      (candidate) => candidate.type === "user_message" && candidate.messageId === messageId,
    );
    return {
      ...messages[0]!,
      itemSummary: item?.type === "user_message" ? item.summary : undefined,
    };
  });

it.effect("summarizes each long incoming card once and stores the summary on the message", () => {
  const harness = makeHarness({});
  return Effect.gen(function* () {
    const summaries = yield* MessageSummary.MessageSummaryService;
    const threadId = yield* createThread("once");
    const cardEffects = yield* send(threadId, "command:card", longReport, report);
    const messageId = MessageId.make("command:card:message");
    assert.deepStrictEqual(cardEffects, [messageId]);
    assert.deepStrictEqual(yield* send(threadId, "command:own", longReport, { kind: "user" }), []);
    assert.deepStrictEqual(yield* send(threadId, "command:short", "Done: gate green.", report), []);

    const before = yield* readMessage(threadId, messageId);
    yield* summaries.execute({ threadId, messageId });
    yield* summaries.execute({ threadId, messageId });
    const after = yield* readMessage(threadId, messageId);

    assert.strictEqual(harness.generateMessageSummary.mock.calls.length, 1);
    const input = harness.generateMessageSummary.mock.calls[0]![0];
    assert.strictEqual(input.source, 'Report from delegated task "Build BW-1"');
    assert.strictEqual(input.message, longReport);
    assert.strictEqual(input.modelSelection.model, "claude-haiku-5-5");
    assert.strictEqual(after.summary, "Done: BW-1 gate green");
    assert.strictEqual(after.itemSummary, "Done: BW-1 gate green");
    assert.strictEqual(after.text, longReport);
    assert.deepStrictEqual(after.updatedAt, before.updatedAt);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  ["the setting is off", { summaries: false }],
  ["the daily cap is spent", { dailyLimit: 0 }],
  [
    "generation fails",
    {
      generate: () =>
        Effect.fail(
          new TextGenerationError({ operation: "generateMessageSummary", detail: "offline" }),
        ),
    },
  ],
] as const)("leaves the first-line fallback when %s", ([, options]) => {
  const harness = makeHarness(options);
  return Effect.gen(function* () {
    const threadId = yield* createThread("fallback");
    yield* send(threadId, "command:fallback", longReport, report);
    const messageId = MessageId.make("command:fallback:message");
    yield* (yield* MessageSummary.MessageSummaryService).execute({ threadId, messageId });
    assert.isUndefined((yield* readMessage(threadId, messageId)).summary);
  }).pipe(Effect.provide(harness.layer));
});

const executeInFreshService = (
  harness: ReturnType<typeof makeHarness>,
  input: { readonly threadId: ThreadId; readonly messageId: MessageId },
) =>
  Effect.flatMap(MessageSummary.MessageSummaryService, (service) => service.execute(input)).pipe(
    Effect.provide(harness.layerSummary()),
  );

it.effect("never pays twice for one message across restarts", () => {
  const harness = makeHarness({
    generate: () =>
      Effect.fail(new TextGenerationError({ operation: "generateMessageSummary", detail: "lost" })),
  });
  return Effect.gen(function* () {
    const threadId = yield* createThread("restart");
    yield* send(threadId, "command:restart", longReport, report);
    const messageId = MessageId.make("command:restart:message");
    yield* executeInFreshService(harness, { threadId, messageId });
    yield* executeInFreshService(harness, { threadId, messageId });
    assert.strictEqual(harness.generateMessageSummary.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.layerBase));
});

it.effect("keeps the daily cap across restarts", () => {
  const harness = makeHarness({ dailyLimit: 1 });
  return Effect.gen(function* () {
    const threadId = yield* createThread("cap");
    for (const name of ["first", "second"]) {
      yield* send(threadId, `command:cap:${name}`, longReport, report);
      yield* executeInFreshService(harness, {
        threadId,
        messageId: MessageId.make(`command:cap:${name}:message`),
      });
    }
    assert.strictEqual(harness.generateMessageSummary.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.layerBase));
});

it.effect("drops a summary whose message was edited while it was generated", () => {
  const threadId = ThreadId.make("thread:message-summary:race");
  const messageId = MessageId.make("command:race:message");
  const edited = `Edited result: deployment failed. ${"Do not land this branch. ".repeat(12)}`;
  let threads: ThreadManagement.ThreadManagementService["Service"] | undefined;
  const harness = makeHarness({
    generate: () =>
      Effect.gen(function* () {
        if (threads === undefined) return yield* Effect.die("thread service not captured");
        const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
        const run = runs.find((candidate) => candidate.userMessageId === messageId)!;
        yield* threads.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("command:race:edit"),
          threadId,
          runId: run.id,
          text: edited,
        });
        return { summary: "Done: deployment passed" };
      }).pipe(Effect.orDie),
  });
  return Effect.gen(function* () {
    threads = yield* ThreadManagement.ThreadManagementService;
    yield* createThread("race");
    yield* (yield* ThreadManagement.ThreadManagementService).dispatch({
      type: "message.dispatch",
      origin: { kind: "user" },
      commandId: CommandId.make("command:race:active"),
      threadId,
      messageId: MessageId.make("command:race:active:message"),
      text: "Active turn",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* (yield* ThreadManagement.ThreadManagementService).dispatch({
      type: "message.dispatch",
      origin: report,
      commandId: CommandId.make("command:race"),
      threadId,
      messageId,
      text: longReport,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
    yield* (yield* MessageSummary.MessageSummaryService).execute({ threadId, messageId });
    const after = yield* readMessage(threadId, messageId);
    assert.strictEqual(after.text, edited);
    assert.isUndefined(after.summary);
    assert.isUndefined(after.itemSummary);
    assert.strictEqual(harness.generateMessageSummary.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});
