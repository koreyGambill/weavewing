import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

export const xwingEnvironmentsList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "xwing-environments:list",
  tag: WS_METHODS.xwingEnvironmentsList,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});

export const xwingEnvironmentInspect = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "xwing-environments:inspect",
  tag: WS_METHODS.xwingEnvironmentsInspect,
  staleTimeMs: 10_000,
  idleTtlMs: 30_000,
});

export const developmentEnvironmentCheckouts = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "development-environments:list-checkouts",
    tag: WS_METHODS.developmentEnvironmentsListCheckouts,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
  },
);

export const developmentEnvironmentUsage = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "development-environments:list-usage",
    tag: WS_METHODS.developmentEnvironmentsListUsage,
    staleTimeMs: 10_000,
    idleTtlMs: 60_000,
  },
);

export const selectDevelopmentEnvironmentCheckout = createEnvironmentRpcCommand(
  connectionAtomRuntime,
  {
    label: "development-environments:select-checkout",
    tag: WS_METHODS.developmentEnvironmentsSelectCheckout,
  },
);

export function useXwingEnvironmentsSupport(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.xwingEnvironments === true
  );
}

export const changeThreadFolder = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "threads:change-folder",
  tag: WS_METHODS.threadsChangeFolder,
});

/** Moves a stopped thread into a new worktree on a new branch, as the agent handoff tool does. */
export const handoffThreadToWorktree = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "threads:handoff-to-worktree",
  tag: WS_METHODS.threadsHandoffToWorktree,
});

export const unlinkThreadEnvironment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "development-environments:unlink",
  tag: WS_METHODS.developmentEnvironmentsUnlink,
});
