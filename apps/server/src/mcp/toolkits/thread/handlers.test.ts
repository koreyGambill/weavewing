import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as MonitoringDialogue from "../../../monitoring/MonitoringDialogue.ts";
import * as NotificationService from "../../../notifications/NotificationService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as AutomationLimits from "../../../scheduledTasks/AutomationLimits.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ContextRecords from "../../../threadInsights/ContextRecords.ts";
import * as Footprints from "../../../threadInsights/InstructionFootprints.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";

it.effect("defaults to compact context pages and lets callers request full tool lists", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("context-reader");
    const at = "2026-11-09T12:00:00.000Z";
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${threadId},'project','Context','codex','full-access','default',${at},${at},'{}')`;
    for (const ordinal of [1, 2, 3, 4, 5]) {
      const runId = `context-${ordinal}`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (${runId},${threadId},${ordinal},'codex','completed',${at},'{}')`;
    }
    const scope: Invocation.McpInvocationScope = {
      environmentId: EnvironmentId.make("context-environment"),
      requestNamespace: "context-session",
      issuedAt: 0,
      capabilities: new Set(["orchestration"]),
      thread: {
        threadId,
        providerSessionId: "context-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
    };
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      protocolVersion: "2025-06-18",
      clientCapabilities: {},
      clientInfo: { name: "context-test", version: "1" },
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "context-test", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    const server = yield* McpServer.McpServer;
    const compact = yield* server
      .callTool({ name: "t3_context_read", arguments: {} })
      .pipe(
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(compact.isError).not.toBe(true);
    expect(compact.structuredContent).toMatchObject({
      threadId,
      records: [{ ordinal: 5 }, { ordinal: 4 }, { ordinal: 3 }],
      nextBeforeOrdinal: 3,
    });
    expect(Buffer.byteLength(JSON.stringify(compact.structuredContent))).toBeLessThanOrEqual(24000);
    expect(JSON.stringify(compact.structuredContent)).not.toContain('"tool-0"');
    expect(JSON.stringify(compact.structuredContent)).toContain('"injectedToolCount":256');
    const expanded = yield* server
      .callTool({
        name: "t3_context_read",
        arguments: {
          beforeOrdinal: 3,
          limit: 1,
          maxBytes: 160000,
          includeInjectedTools: true,
        },
      })
      .pipe(
        Effect.provideService(Invocation.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(expanded.isError).not.toBe(true);
    expect(expanded.structuredContent).toMatchObject({
      threadId,
      records: [
        { ordinal: 2, instructions: [{ injectedTools: expect.arrayContaining(["tool-0"]) }] },
      ],
      nextBeforeOrdinal: 2,
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(MonitoringDialogue.MonitoringDialogue)({})),
        Layer.provide(Layer.mock(NotificationService.NotificationService)({})),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
            getProjectThreadRecords: ({ threadId }) =>
              Effect.succeed(idleThreadProjection(liveThreadShell(threadId))),
          }),
        ),
        Layer.provide(
          ContextRecords.layer.pipe(
            Layer.provide(
              Layer.mock(Footprints.InstructionFootprints)({
                list: (threadId, runId) =>
                  Effect.succeed([
                    {
                      threadId,
                      runId: runId!,
                      providerInstanceId: ProviderInstanceId.make("codex"),
                      driver: "codex",
                      model: "test",
                      capturedAt: "2026-11-09T12:00:00.000Z",
                      source: "test",
                      parts: [],
                      injectedToolCount: 256,
                      injectedTools: Array.from({ length: 256 }, (_, index) => `tool-${index}`),
                    },
                  ]),
              }),
            ),
          ),
        ),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);

it.effect("t3_notify raises from the calling thread and links the thread it names", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const notifications = yield* NotificationService.NotificationService;
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      protocolVersion: "2025-06-18",
      clientCapabilities: {},
      clientInfo: { name: "notify-test", version: "1" },
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "notify-test", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    const callerId = ThreadId.make("notify-caller");
    const scope = (thread: boolean, threadId = callerId): Invocation.McpInvocationScope => ({
      environmentId: EnvironmentId.make("notify-environment"),
      requestNamespace: "notify-session",
      issuedAt: 0,
      capabilities: new Set(["orchestration"]),
      thread: thread
        ? {
            threadId,
            providerSessionId: "notify-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          }
        : undefined,
      client: undefined,
    });
    const notify = (args: Record<string, unknown>, thread = true, threadId = callerId) =>
      server
        .callTool({ name: "t3_notify", arguments: args })
        .pipe(
          Effect.provideService(Invocation.McpInvocationContext, scope(thread, threadId)),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const first = yield* notify({ title: "Lands ran from bash", severity: "warning" });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ status: "delivered" });
    const repeat = yield* notify({ title: "Lands ran from bash", severity: "warning" });
    expect(repeat.structuredContent).toEqual(
      first.structuredContent && {
        ...first.structuredContent,
        status: "repeat",
      },
    );
    yield* notify({ title: "PR merged", threadId: "notify-target" });
    const snapshot = yield* notifications.subscribe().pipe(Stream.runHead);
    expect(Option.getOrThrow(snapshot).items).toMatchObject([
      {
        title: "PR merged",
        severity: "info",
        threadId: "notify-target",
        source: { kind: "agent", threadId: callerId },
      },
      { title: "Lands ran from bash", severity: "warning", threadId: callerId, repeatCount: 1 },
    ]);

    expect(JSON.stringify((yield* notify({ title: "x", threadId: "missing" })).content)).toContain(
      "thread was not found",
    );
    expect((yield* notify({ title: "x" }, false)).isError).toBe(true);
    const muted = yield* notify({ title: "x" }, true, ThreadId.make("notify-muted"));
    expect(JSON.stringify(muted.content)).toContain("turn notifications off");
    const tooLong = yield* Effect.flip(notify({ title: "x".repeat(121) }));
    expect(tooLong.message).toContain("at most 120");
    expect(
      Option.getOrThrow(yield* notifications.subscribe().pipe(Stream.runHead)).items,
    ).toHaveLength(2);
    for (let index = 0; index < NotificationService.RATE_LIMIT_PER_HOUR - 3; index++)
      yield* notify({ title: `finding ${index}` });
    expect(JSON.stringify((yield* notify({ title: "one too many" })).content)).toContain(
      "notifications per hour",
    );
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(NotificationService.layer),
        Layer.provide(
          Layer.mock(AutomationLimits.AutomationLimits)({
            allowsNotify: (threadId) => Effect.succeed(threadId !== "notify-muted"),
          }),
        ),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(MonitoringDialogue.MonitoringDialogue)({})),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(ScheduledTasks.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ContextRecords.ContextRecords)({})),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(id === "missing" ? null : liveThreadShell(id)),
          }),
        ),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  ),
);
