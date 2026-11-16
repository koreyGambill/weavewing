import { WS_METHODS } from "@t3tools/contracts";
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
export const threadListUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "list:update",
  tag: WS_METHODS.threadListUpdate,
  // The left strip's Todos badge counts open items from the workspace query.
  onSuccess: ({ environmentId, input }, registry) =>
    Effect.sync(() =>
      registry.refresh(sidebarWorkspaceGet({ environmentId, input: { threadId: input.threadId } })),
    ),
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
