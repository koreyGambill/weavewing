import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadMcpServers from "./ThreadMcpServers.ts";

const threadId = ThreadId.make("thread-mcp");
const providerThreadId = ProviderThreadId.make("provider-thread-mcp");
const sessionId = ProviderSessionId.make("session-mcp");
const server = (name: string, source: string): ProviderAdapter.ProviderAdapterV2McpServer => ({
  name,
  source,
  status: "connected",
});

function layer(input: {
  readonly driver?: string;
  readonly live?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer> | "stalls";
  readonly probe: Effect.Effect<
    ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer>,
    ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly probes: Array<string | null>;
}) {
  return ThreadMcpServers.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                providerInstanceId: ProviderInstanceId.make("claude-fixture"),
                activeProviderThreadId: providerThreadId,
                projectId: ProjectId.make("project-mcp"),
                worktreePath: null,
              },
              providerThreads: [{ id: providerThreadId, providerSessionId: sessionId }],
            } as never),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome({ workspaceRoot: "/fixture/project" } as never),
        }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          get: () =>
            Effect.succeed({
              driver: ProviderDriverKind.make(input.driver ?? "claudeAgent"),
              probeMcpServers: ({ cwd }: { readonly cwd: string | null }) => {
                input.probes.push(cwd);
                return input.probe;
              },
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.live === undefined
                ? Option.none()
                : Option.some({
                    listMcpServers: () =>
                      input.live === "stalls" ? Effect.never : Effect.succeed(input.live),
                  } as never),
            ),
        }),
      ),
    ),
  );
}

const list = Effect.gen(function* () {
  const service = yield* ThreadMcpServers.ThreadMcpServers;
  return yield* service.list({ threadId });
});

it.effect("answers from the live session when it already loaded the connectors", () => {
  const probes: Array<string | null> = [];
  return list.pipe(
    Effect.map(({ servers }) => {
      assert.deepEqual(servers, [
        { name: "fixture-notes", connector: false, status: "connected", active: true },
        { name: "claude.ai Fixture Board", connector: true, status: "connected", active: true },
      ]);
      assert.deepEqual(probes, []);
    }),
    Effect.provide(
      layer({
        live: [
          server("t3-code", "dynamic"),
          server("claude.ai Fixture Board", "claudeai"),
          server("fixture-notes", "user"),
        ],
        probe: Effect.succeed([]),
        probes,
      }),
    ),
  );
});

it.effect("probes for connectors a live session left out, and for a thread with no session", () =>
  Effect.gen(function* () {
    const probe = Effect.succeed([
      server("fixture-notes", "user"),
      server("claude.ai Fixture Board", "claudeai"),
    ]);
    const liveProbes: Array<string | null> = [];
    const live = yield* list.pipe(
      Effect.provide(layer({ live: [server("fixture-notes", "user")], probe, probes: liveProbes })),
    );
    // The probe's connectors are only discovered: the live session did not load them.
    assert.deepEqual(
      live.servers.map((entry) => [entry.name, entry.connector, entry.active]),
      [
        ["fixture-notes", false, true],
        ["claude.ai Fixture Board", true, false],
      ],
    );
    assert.deepEqual(liveProbes, ["/fixture/project"]);
    const idleProbes: Array<string | null> = [];
    const idle = yield* list.pipe(Effect.provide(layer({ probe, probes: idleProbes })));
    assert.deepEqual(
      idle.servers.map((entry) => entry.active),
      [false, false],
    );
    assert.deepEqual(idleProbes, ["/fixture/project"]);
  }),
);

it.effect("fails without a session when the probe fails, and keeps live servers otherwise", () =>
  Effect.gen(function* () {
    const probe = Effect.fail(
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver: ProviderDriverKind.make("claudeAgent"),
        detail: "Could not list Claude MCP servers.",
      }),
    );
    const failure = yield* list.pipe(Effect.provide(layer({ probe, probes: [] })), Effect.flip);
    assert.equal(failure.reason, "failed");
    const live = yield* list.pipe(
      Effect.provide(layer({ live: [server("fixture-notes", "user")], probe, probes: [] })),
    );
    assert.deepEqual(
      live.servers.map((entry) => entry.name),
      ["fixture-notes"],
    );
  }),
);

it.effect("falls back to the probe when the live session never answers", () =>
  Effect.gen(function* () {
    const probes: Array<string | null> = [];
    const listing = yield* list.pipe(
      Effect.provide(
        layer({
          live: "stalls",
          probe: Effect.succeed([server("fixture-notes", "user")]),
          probes,
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("4 seconds");
    const { servers } = yield* Fiber.join(listing);
    assert.deepEqual(
      servers.map((entry) => entry.name),
      ["fixture-notes"],
    );
    assert.deepEqual(probes, ["/fixture/project"]);
  }),
);

it.effect("refuses a thread that is not on Claude", () =>
  list.pipe(
    Effect.flip,
    Effect.map((failure) => assert.equal(failure.reason, "unsupported-provider")),
    Effect.provide(layer({ driver: "codex", probe: Effect.succeed([]), probes: [] })),
  ),
);
