import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  clientRpcRequiredScopes,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("requires operate scope for draft changes, explicit generation, and sends", () => {
    for (const method of [
      WS_METHODS.threadDefaultContextGet,
      WS_METHODS.threadWorkspaceGet,
      WS_METHODS.threadTimelineGet,
      WS_METHODS.threadListRead,
      WS_METHODS.threadArtifactRead,
      WS_METHODS.threadArtifactList,
      WS_METHODS.reviewsGet,
      WS_METHODS.reviewsList,
      WS_METHODS.reviewsDue,
      WS_METHODS.messageFollowUpsList,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.threadDefaultContextItem)).toBe(
      AuthFilesystemReadScope,
    );
    for (const method of [
      ORCHESTRATION_V2_WS_METHODS.prepareSummaryHandoff,
      ORCHESTRATION_V2_WS_METHODS.rewindWithSummary,
      WS_METHODS.threadListUpdate,
      WS_METHODS.threadListRewrite,
      WS_METHODS.threadArtifactWrite,
      WS_METHODS.threadArtifactAnswer,
      WS_METHODS.threadArtifactSubmit,
      WS_METHODS.threadQuestionUpdate,
      WS_METHODS.threadTrackMessage,
      WS_METHODS.threadUpdateAsk,
      WS_METHODS.threadQuestionDraft,
      WS_METHODS.threadMarksAnnotate,
      WS_METHODS.reviewsCreate,
      WS_METHODS.reviewsSave,
      WS_METHODS.reviewsSubmit,
      WS_METHODS.messageFollowUpsUpdate,
      WS_METHODS.evidenceSetQa,
      WS_METHODS.evidenceBulkSetQa,
      ORCHESTRATION_V2_WS_METHODS.setThreadToolOverrides,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    // A read-only connection sees no bulk dismiss, and the server refuses one it sends anyway.
    expect(clientRpcRequiredScopes(WS_METHODS.evidenceBulkSetQa, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });

  it("lets read-only connections discover Xwing environments but not move threads into one", () => {
    for (const method of [
      WS_METHODS.xwingEnvironmentsList,
      WS_METHODS.xwingEnvironmentsInspect,
      WS_METHODS.developmentEnvironmentsListCheckouts,
      WS_METHODS.developmentEnvironmentsListUsage,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.threadsChangeFolder)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.developmentEnvironmentsRestore)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.developmentEnvironmentsSelectCheckout)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("allows imported transcript observation with read scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsProgress)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("treats status source configuration as settings and command sources as terminals", () => {
    expect(requiredScopeForRpcMethod("statusSources.subscribe")).toBe(AuthOrchestrationReadScope);
    expect(requiredScopeForRpcMethod("statusSources.snooze")).toBe(AuthOrchestrationOperateScope);
    for (const method of [
      "statusSources.upsert",
      "statusSources.delete",
      "statusSources.rotateWebhookSecret",
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    }
    expect(clientRpcRequiredScopes("statusSources.upsert", { kind: "command" })).toEqual([
      AuthSettingsWriteScope,
      AuthTerminalOperateScope,
    ]);
    expect(clientRpcRequiredScopes("statusSources.upsert", { kind: "http-health" })).toEqual([
      AuthSettingsWriteScope,
    ]);
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.terminalMove,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("lets thread readers observe and refresh checkout branches", () => {
    for (const method of [WS_METHODS.subscribeVcsBranch, WS_METHODS.vcsRefreshBranch]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("still lets readers load settings the way installed Swift clients ask", () => {
    expect(requiredScopeForRpcMethod("server.getSettings")).toBe(AuthOrchestrationReadScope);
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("guards a thread's tool changes and MCP server listing on the client too", () => {
  expect(
    clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.listThreadMcpServers, {
      threadId: "thread-1",
    }),
  ).toEqual([AuthOrchestrationReadScope]);
  expect(
    clientRpcRequiredScopes(ORCHESTRATION_V2_WS_METHODS.setThreadToolOverrides, {
      threadId: "thread-1",
    }),
  ).toEqual([AuthOrchestrationOperateScope]);
});

it("serves automation summaries to readers and guards them on the client too", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.scheduledTasksSubscribeSummaries)).toBe(
    requiredScopeForRpcMethod(WS_METHODS.scheduledTasksSubscribe),
  );
  expect(clientRpcRequiredScopes(WS_METHODS.scheduledTasksSubscribeSummaries, {})).toEqual([
    AuthOrchestrationReadScope,
  ]);
});

it("requires source control and thread operation to hand a thread off to a worktree", () => {
  const input = { threadId: "thread-1", branch: "feature/handoff" };
  expect(clientRpcRequiredScopes(WS_METHODS.threadsHandoffToWorktree, input)).toEqual([
    AuthSourceControlWriteScope,
    AuthOrchestrationOperateScope,
  ]);
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }),
  );
});

const summaryHandoffMethod = ORCHESTRATION_V2_WS_METHODS.prepareSummaryHandoff;
const summaryHandoffGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof summaryHandoffMethod> =>
      tag !== summaryHandoffMethod,
  ),
);

it.effect.each([
  { scopes: [AuthOrchestrationOperateScope], missing: AuthOrchestrationReadScope },
  { scopes: [AuthOrchestrationReadScope], missing: AuthOrchestrationOperateScope },
  { scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope], missing: null },
])("requires read and operate for summary preparation (missing $missing)", ({ scopes, missing }) =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(summaryHandoffGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          summaryHandoffGroup.toLayerHandler(summaryHandoffMethod, () =>
            Effect.succeed({ kind: "excerpt" as const, text: "Conversation", truncated: false }),
          ),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );
    const input = { threadId: ThreadId.make("summary-source"), strategy: "portable" as const };
    if (missing === null) {
      expect(yield* client[summaryHandoffMethod](input)).toMatchObject({ text: "Conversation" });
    } else {
      expect(yield* client[summaryHandoffMethod](input).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
    }
  }),
);

it.effect(
  "rejects status source mutations before executing a configured command or changing secrets",
  () =>
    Effect.gen(function* () {
      const tested = [
        WS_METHODS.statusSourcesSubscribe,
        WS_METHODS.statusSourcesUpsert,
        WS_METHODS.statusSourcesDelete,
        WS_METHODS.statusSourcesSnooze,
        WS_METHODS.statusSourcesRotateWebhookSecret,
      ] as const;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
            !(tested as ReadonlyArray<string>).includes(tag),
        ),
      );
      const handled: Array<string> = [];
      const mutation = Effect.sync(() => handled.push("mutation")).pipe(
        Effect.andThen(Effect.never),
      );
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.statusSourcesSubscribe, () => Stream.succeed([])),
            group.toLayerHandler(WS_METHODS.statusSourcesUpsert, () => mutation),
            group.toLayerHandler(WS_METHODS.statusSourcesDelete, () => mutation),
            group.toLayerHandler(WS_METHODS.statusSourcesSnooze, () => mutation),
            group.toLayerHandler(WS_METHODS.statusSourcesRotateWebhookSecret, () => mutation),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      expect(yield* Stream.runHead(client[WS_METHODS.statusSourcesSubscribe]({}))).toMatchObject({
        value: [],
      });
      const denied = {
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthSettingsWriteScope,
      };
      expect(
        yield* client[WS_METHODS.statusSourcesUpsert]({
          name: "Checks",
          kind: "command",
          icon: "terminal",
          target: "check",
        }).pipe(Effect.flip),
      ).toMatchObject(denied);
      expect(
        yield* client[WS_METHODS.statusSourcesDelete]({ id: "checks" }).pipe(Effect.flip),
      ).toMatchObject(denied);
      expect(
        yield* client[WS_METHODS.statusSourcesSnooze]({ id: "checks", until: null }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ ...denied, requiredPermission: AuthOrchestrationOperateScope });
      expect(
        yield* client[WS_METHODS.statusSourcesRotateWebhookSecret]({ id: "checks" }).pipe(
          Effect.flip,
        ),
      ).toMatchObject(denied);
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect.each([WS_METHODS.subscribeVcsBranch, WS_METHODS.subscribeVcsStatus] as const)(
  "enforces read permission on stream %s",
  (method) =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.subscribeVcsBranch | typeof WS_METHODS.subscribeVcsStatus
          > => tag !== WS_METHODS.subscribeVcsBranch && tag !== WS_METHODS.subscribeVcsStatus,
        ),
      );
      let handled = 0;
      const handlers = Layer.mergeAll(
        group.toLayerHandler(WS_METHODS.subscribeVcsBranch, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
              return { refName: "main" };
            }),
          ),
        ),
        group.toLayerHandler(WS_METHODS.subscribeVcsStatus, () =>
          Stream.fromEffect(
            Effect.sync(() => {
              handled++;
            }),
          ).pipe(Stream.drain),
        ),
      );
      const denied = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([]))),
      );
      expect(
        yield* Stream.runDrain(
          method === WS_METHODS.subscribeVcsBranch
            ? denied[method]({ cwd: "/repo" }).pipe(Stream.drain)
            : denied[method]({ cwd: "/repo" }).pipe(Stream.drain),
        ).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
      expect(handled).toBe(0);
      const granted = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
      );
      yield* Stream.runDrain(
        method === WS_METHODS.subscribeVcsBranch
          ? granted[method]({ cwd: "/repo" }).pipe(Stream.drain)
          : granted[method]({ cwd: "/repo" }).pipe(Stream.drain),
      );
      expect(handled).toBe(1);
    }),
);

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      // Removing a secret provider clears settings fields that read from it.
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }),
  );

  it.effect(
    "does not let a settings grant manage providers or turn off T3 Connect device approval",
    () =>
      Effect.gen(function* () {
        let handled = false;
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
                Effect.sync(() => {
                  handled = true;
                  return DEFAULT_SERVER_SETTINGS;
                }),
              ),
              RpcAuthorization.layer([AuthSettingsWriteScope]),
            ),
          ),
        );
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: {},
            providerInstanceMutation,
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { requireConnectDeviceApproval: false },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthAccessWriteScope });
        // Tailnet pairing decides who may pair, which only an access grant may change.
        expect(
          yield* client[WS_METHODS.serverUpdateSettings]({
            patch: { tailnetConnect: { enabled: true } },
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthAccessWriteScope });
        expect(handled).toBe(false);
      }),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }),
);

it.effect("refuses a worktree handoff to a connection that cannot move threads", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.threadsHandoffToWorktree
        > => tag !== WS_METHODS.threadsHandoffToWorktree,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.threadsHandoffToWorktree, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.threadsHandoffToWorktree]({
        threadId: ThreadId.make("thread"),
        branch: "feature/handoff",
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "native-app-icon", app: { _tag: "app-id", appId: "com.apple.calculator" } },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
      { _tag: "native-app-icon", app: { _tag: "app-path", path: "/private/Secret.app" } },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(2);
  }),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }),
);

it.effect("lets only connections that can run host commands grant outside edits", () =>
  Effect.gen(function* () {
    type GrantMethod =
      | typeof WS_METHODS.projectsAllowOutsideEdits
      | typeof WS_METHODS.projectsRevokeOutsideEdits;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, GrantMethod> =>
          tag !== WS_METHODS.projectsAllowOutsideEdits &&
          tag !== WS_METHODS.projectsRevokeOutsideEdits,
      ),
    );
    let handled = 0;
    const grant = { kind: "file" as const, path: "/home/user/.claude/skills/x/SKILL.md" };
    const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.projectsAllowOutsideEdits, () =>
              Effect.sync(() => {
                handled++;
                return grant;
              }),
            ),
            group.toLayerHandler(WS_METHODS.projectsRevokeOutsideEdits, () =>
              Effect.sync(() => {
                handled++;
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const allow = { cwd: "/repo", relativePath: grant.path, scope: "workspace" as const };
    const reader = yield* clientWith([AuthOrchestrationReadScope, AuthFilesystemReadScope]);
    expect(
      yield* reader[WS_METHODS.projectsAllowOutsideEdits](allow).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthFilesystemWriteScope });
    expect(
      yield* reader[WS_METHODS.projectsRevokeOutsideEdits]({ grant }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthFilesystemWriteScope });
    expect(handled).toBe(0);

    // A grant can make ~/.bashrc or ~/.gitconfig writable, so file access alone is not enough.
    const fileWriter = yield* clientWith([AuthOrchestrationOperateScope, AuthFilesystemWriteScope]);
    expect(
      yield* fileWriter[WS_METHODS.projectsAllowOutsideEdits](allow).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthTerminalOperateScope });
    expect(
      yield* fileWriter[WS_METHODS.projectsRevokeOutsideEdits]({ grant }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthTerminalOperateScope });
    const terminalOnly = yield* clientWith([AuthTerminalOperateScope]);
    expect(
      yield* terminalOnly[WS_METHODS.projectsAllowOutsideEdits](allow).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthFilesystemWriteScope });
    expect(handled).toBe(0);

    const writer = yield* clientWith([AuthFilesystemWriteScope, AuthTerminalOperateScope]);
    expect(yield* writer[WS_METHODS.projectsAllowOutsideEdits](allow)).toEqual(grant);
    yield* writer[WS_METHODS.projectsRevokeOutsideEdits]({ grant });
    expect(handled).toBe(2);
  }),
);

it.effect("lets only host-command connections edit agent context", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.agentContextSave> =>
          tag !== WS_METHODS.agentContextSave,
      ),
    );
    let handled = 0;
    const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
      RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.agentContextSave, () =>
              Effect.sync(() => {
                handled++;
                return { sha256: "new" };
              }),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
    const target = {
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      projectId: ProjectId.make("project"),
    };
    const save = {
      ...target,
      realPath: "/home/user/AGENTS.md",
      contents: "x",
      expectedSha256: "old",
    };

    // An instruction file steers agents that run commands, so file access alone is not enough.
    const fileWriter = yield* clientWith([AuthOrchestrationOperateScope, AuthFilesystemWriteScope]);
    expect(yield* fileWriter[WS_METHODS.agentContextSave](save).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthTerminalOperateScope,
    });
    const terminalOnly = yield* clientWith([AuthTerminalOperateScope]);
    expect(yield* terminalOnly[WS_METHODS.agentContextSave](save).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthFilesystemWriteScope,
    });
    expect(handled).toBe(0);

    const editor = yield* clientWith([AuthFilesystemWriteScope, AuthTerminalOperateScope]);
    expect(yield* editor[WS_METHODS.agentContextSave](save)).toEqual({ sha256: "new" });
    expect(handled).toBe(1);
  }),
);
