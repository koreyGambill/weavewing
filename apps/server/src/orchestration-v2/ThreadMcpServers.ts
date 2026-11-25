import {
  type OrchestrationV2ListThreadMcpServersInput,
  type OrchestrationV2ListThreadMcpServersResult,
  OrchestrationV2ListThreadMcpServersError,
  T3_MCP_SERVER_NAME,
  type ThreadMcpServer,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class ThreadMcpServers extends Context.Service<
  ThreadMcpServers,
  {
    /**
     * The MCP servers a Claude thread's session can load, for its per-thread switches. A live
     * session answers for what it loaded; a probe fills in what it cannot see, such as claude.ai
     * connectors a setting keeps out, or everything when no session is open.
     */
    readonly list: (
      input: OrchestrationV2ListThreadMcpServersInput,
    ) => Effect.Effect<
      OrchestrationV2ListThreadMcpServersResult,
      OrchestrationV2ListThreadMcpServersError
    >;
  }
>()("t3/orchestration-v2/ThreadMcpServers") {}

const CLAUDE_AI_SOURCE = "claudeai";
const LIVE_STATUS_READ_TIMEOUT = "3 seconds";

/** Live entries win; probed ones add only servers the live process did not load. */
function mergeThreadMcpServers(
  live: ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer> | undefined,
  probed: ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer>,
): ReadonlyArray<ThreadMcpServer> {
  const byName = new Map<string, ProviderAdapter.ProviderAdapterV2McpServer>();
  for (const server of [...(live ?? []), ...probed]) {
    if (server.name === T3_MCP_SERVER_NAME || byName.has(server.name)) continue;
    byName.set(server.name, server);
  }
  return [...byName.values()]
    .map((server) => ({
      name: server.name,
      connector: server.source === CLAUDE_AI_SOURCE,
      status: server.status,
    }))
    .toSorted(
      (left, right) =>
        Number(left.connector) - Number(right.connector) || left.name.localeCompare(right.name),
    );
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const list = Effect.fn("ThreadMcpServers.list")(function* (
    input: OrchestrationV2ListThreadMcpServersInput,
  ) {
    const failed = (cause: unknown) =>
      new OrchestrationV2ListThreadMcpServersError({
        threadId: input.threadId,
        reason: "failed",
        cause,
      });
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError(failed));
    const { thread } = records;
    const adapter = yield* adapters.get(thread.providerInstanceId).pipe(Effect.mapError(failed));
    if (adapter.driver !== "claudeAgent") {
      return yield* new OrchestrationV2ListThreadMcpServersError({
        threadId: input.threadId,
        reason: "unsupported-provider",
      });
    }
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const runtime =
      providerThread?.providerSessionId == null
        ? Option.none()
        : yield* sessions
            .get(providerThread.providerSessionId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
    // A live process that cannot answer is no worse than none: the probe still lists servers.
    const live =
      providerThread === undefined || Option.isNone(runtime)
        ? undefined
        : yield* (runtime.value.listMcpServers?.({ providerThread }) ?? Effect.undefined).pipe(
            // A busy or stuck process may never answer; the probe can still list the servers.
            Effect.timeout(LIVE_STATUS_READ_TIMEOUT),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not read the live session's MCP servers.", { cause }).pipe(
                Effect.as(undefined),
              ),
            ),
          );
    // Connectors switched off never load, so only a probe learns their names.
    const needsProbe =
      live === undefined || !live.some((server) => server.source === CLAUDE_AI_SOURCE);
    if (!needsProbe || adapter.probeMcpServers === undefined) {
      return { servers: mergeThreadMcpServers(live, []) };
    }
    const project = yield* projects.get(thread.projectId).pipe(Effect.mapError(failed));
    const cwd =
      thread.worktreePath ?? (Option.isSome(project) ? project.value.workspaceRoot : null);
    const probed = yield* adapter.probeMcpServers({ cwd }).pipe(
      Effect.map((servers): ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer> => servers),
      live === undefined
        ? Effect.mapError(failed)
        : Effect.catchCause((cause) =>
            Effect.logWarning("Could not probe Claude MCP servers.", { cause }).pipe(Effect.as([])),
          ),
    );
    return { servers: mergeThreadMcpServers(live, probed) };
  });

  return ThreadMcpServers.of({ list });
});

export const layer = Layer.effect(ThreadMcpServers, make);
