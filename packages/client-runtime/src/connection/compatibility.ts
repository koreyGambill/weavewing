import {
  AUTOMATIONS_CLIENT_CAPABILITY,
  ASSISTANT_TEXT_PARTS_CAPABILITY,
  CLIENT_CAPABILITIES_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  PEER_LINK_UNAUTHORIZED_STATUS_CAPABILITY,
  SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY,
  SCHEDULED_TASK_SKIPPED_STATUS_CAPABILITY,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  TERMINAL_WORKSPACE_CHANGED_ERROR_CAPABILITY,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { ConnectionBlockedError } from "./model.ts";

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  // Servers shipped before negotiation use the original wire protocol.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  return serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
    ? new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client is not supported by this server. Update your app or use a compatible release to connect to ${descriptor.label}.`,
      })
    : new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client requires a newer server. Update T3 Code on ${descriptor.label} to connect.`,
        ...(canSelfUpdate(descriptor) ? { serverUpdateRequired: true } : {}),
      });
}

function canSelfUpdate(descriptor: ExecutionEnvironmentDescriptor): boolean {
  const { serverSelfUpdate, desktopAppUpdate } = descriptor.capabilities;
  return (
    serverSelfUpdate !== undefined &&
    (serverSelfUpdate !== "desktop-managed" || desktopAppUpdate === true)
  );
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(CLIENT_CAPABILITIES_QUERY_PARAM, CLIENT_WIRE_CAPABILITIES);
  return url.toString();
}

/** Every wire shape this client understands, as the `clientCapabilities` value. */
export const CLIENT_WIRE_CAPABILITIES = [
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  SCHEDULED_TASK_SKIPPED_STATUS_CAPABILITY,
  PEER_LINK_UNAUTHORIZED_STATUS_CAPABILITY,
  TERMINAL_WORKSPACE_CHANGED_ERROR_CAPABILITY,
  SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY,
  ASSISTANT_TEXT_PARTS_CAPABILITY,
  AUTOMATIONS_CLIENT_CAPABILITY,
].join(",");
