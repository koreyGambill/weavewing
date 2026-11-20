import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const statusSources = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "status-sources:subscribe",
  tag: WS_METHODS.statusSourcesSubscribe,
  idleTtlMs: 0,
});

export const statusSourcesUpsert = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "status-sources:upsert",
  tag: WS_METHODS.statusSourcesUpsert,
});

export const statusSourcesDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "status-sources:delete",
  tag: WS_METHODS.statusSourcesDelete,
});

export const statusSourcesReorder = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "status-sources:reorder",
  tag: WS_METHODS.statusSourcesReorder,
});

export const statusSourcesSnooze = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "status-sources:snooze",
  tag: WS_METHODS.statusSourcesSnooze,
});

export const statusSourcesRotateWebhookSecret = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "status-sources:rotate-webhook-secret",
  tag: WS_METHODS.statusSourcesRotateWebhookSecret,
});
