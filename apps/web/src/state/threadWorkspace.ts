import { WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

const queryOptions = { staleTimeMs: 2_000, idleTtlMs: 0 };
export const threadWorkspaceGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "workspace:get",
  tag: WS_METHODS.threadWorkspaceGet,
  ...queryOptions,
});
export const threadListRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "list:read",
  tag: WS_METHODS.threadListRead,
  refreshIntervalMs: 5_000,
  ...queryOptions,
});
export const sidebarWorkspaceGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "thread-context:workspace",
  tag: WS_METHODS.threadWorkspaceGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
});
/**
 * Refetches every view of a thread's list after a write: the hidden sidebar's attention dot, the
 * open Checklist view, and the workspace the chat's cards read, so no card acts on a stale revision.
 */
export function refreshTodos(
  registry: AtomRegistry.AtomRegistry,
  target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  },
) {
  const { environmentId } = target;
  const { threadId } = target.input;
  registry.refresh(sidebarWorkspaceGet({ environmentId, input: { threadId } }));
  registry.refresh(threadListRead({ environmentId, input: { threadId, all: true } }));
  registry.refresh(threadWorkspaceGet({ environmentId, input: { threadId } }));
}
export const threadListUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "list:update",
  tag: WS_METHODS.threadListUpdate,
  onSuccess: (target, registry) => Effect.sync(() => refreshTodos(registry, target)),
});
export const threadArtifactList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "artifact:list",
  tag: WS_METHODS.threadArtifactList,
  refreshIntervalMs: 5_000,
  ...queryOptions,
});
export const threadArtifactAnswer = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "artifact:answer",
  tag: WS_METHODS.threadArtifactAnswer,
});
