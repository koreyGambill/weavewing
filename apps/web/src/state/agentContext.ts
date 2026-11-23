import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentContextGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "agentContext:get",
  tag: WS_METHODS.agentContextGet,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

/** File bodies load only when a source opens for editing. */
export const agentContextRead = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "agentContext:read",
  tag: WS_METHODS.agentContextRead,
  staleTimeMs: 0,
  idleTtlMs: 0,
});

export const agentContextSave = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "agentContext:save",
  tag: WS_METHODS.agentContextSave,
});

export const agentContextCommit = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "agentContext:commit",
  tag: WS_METHODS.agentContextCommit,
});
