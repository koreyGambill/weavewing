import {
  ASSISTANT_TEXT_PARTS_CAPABILITY,
  AUTOMATIONS_CLIENT_CAPABILITY,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  PEER_LINK_UNAUTHORIZED_STATUS_CAPABILITY,
  SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY,
  SCHEDULED_TASK_SKIPPED_STATUS_CAPABILITY,
  ScheduledTaskError,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  TERMINAL_WORKSPACE_CHANGED_ERROR_CAPABILITY,
  TerminalCwdStatError,
  TerminalWorkspaceChangedError,
  WS_METHODS,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type TerminalError,
  type PeerLinkSummary,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import type * as TerminalManager from "./terminal/Manager.ts";

const isTerminalWorkspaceChangedError = Schema.is(TerminalWorkspaceChangedError);

/**
 * Wire shapes the connected client declared through `clientCapabilities`. Upstream T3 Code clients
 * decode the fork's additions strictly, so a value they never declared is mapped to their nearest one.
 * docs/internals/fork-wire-compatibility.md has the rule; upstreamClientCompat.test.ts enforces it.
 */
export interface ClientWireCapabilities {
  readonly secretReferences: boolean;
  readonly scheduledTaskSkippedStatus: boolean;
  readonly peerLinkUnauthorizedStatus: boolean;
  readonly terminalWorkspaceChangedError: boolean;
  readonly scheduledTaskEventSchedule: boolean;
  readonly assistantTextParts: boolean;
  readonly automations: boolean;
}

export function readClientWireCapabilities(param: string | null): ClientWireCapabilities {
  const declared = new Set(param?.split(",") ?? []);
  return {
    secretReferences: declared.has(SETTINGS_SECRET_REFERENCES_CAPABILITY),
    scheduledTaskSkippedStatus: declared.has(SCHEDULED_TASK_SKIPPED_STATUS_CAPABILITY),
    peerLinkUnauthorizedStatus: declared.has(PEER_LINK_UNAUTHORIZED_STATUS_CAPABILITY),
    terminalWorkspaceChangedError: declared.has(TERMINAL_WORKSPACE_CHANGED_ERROR_CAPABILITY),
    scheduledTaskEventSchedule: declared.has(SCHEDULED_TASK_EVENT_SCHEDULE_CAPABILITY),
    assistantTextParts: declared.has(ASSISTANT_TEXT_PARTS_CAPABILITY),
    automations: declared.has(AUTOMATIONS_CLIENT_CAPABILITY),
  };
}

// Upstream clients fold every assistant text of a settled turn but its last into "Worked for",
// unless the text is a final answer. Answers written between tool calls must stay readable there.
function turnItemForClient(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  return item.type === "assistant_message" &&
    item.phase !== "final_answer" &&
    (item.text.trim() !== "" || item.textOmitted === true || (item.attachments?.length ?? 0) > 0)
    ? { ...item, phase: "final_answer" }
    : item;
}

function mapChanged<T>(values: ReadonlyArray<T>, map: (value: T) => T): ReadonlyArray<T> {
  let changed = false;
  const mapped = values.map((value) => {
    const next = map(value);
    changed ||= next !== value;
    return next;
  });
  return changed ? mapped : values;
}

function projectedTurnItemForClient(
  projected: OrchestrationV2ProjectedTurnItem,
): OrchestrationV2ProjectedTurnItem {
  const item = turnItemForClient(projected.item);
  return item === projected.item ? projected : { ...projected, item };
}

function projectionForClient(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const turnItems = mapChanged(projection.turnItems, turnItemForClient);
  const visibleTurnItems = mapChanged(projection.visibleTurnItems, projectedTurnItemForClient);
  return turnItems === projection.turnItems && visibleTurnItems === projection.visibleTurnItems
    ? projection
    : { ...projection, turnItems, visibleTurnItems };
}

function threadStreamItemForClient(
  item: OrchestrationV2ThreadStreamItem,
  client: ClientWireCapabilities,
): OrchestrationV2ThreadStreamItem {
  if (client.assistantTextParts) return item;
  if (item.kind === "snapshot") {
    const projection = projectionForClient(item.projection);
    return projection === item.projection ? item : { ...item, projection };
  }
  if (item.kind !== "event" || item.event.type !== "turn-item.updated") return item;
  const payload = turnItemForClient(item.event.payload);
  return payload === item.event.payload ? item : { ...item, event: { ...item.event, payload } };
}

export const threadHistoryPageForClient = (
  page: OrchestrationV2ThreadHistoryPage,
  client: ClientWireCapabilities,
): OrchestrationV2ThreadHistoryPage =>
  client.assistantTextParts
    ? page
    : { ...page, items: mapChanged(page.items, projectedTurnItemForClient) };

// A skipped check-in ran its check and found nothing to do.
function scheduledTaskForClient(task: ScheduledTask, client: ClientWireCapabilities) {
  return task.lastRunStatus === "skipped" && !client.scheduledTaskSkippedStatus
    ? { ...task, lastRunStatus: "succeeded" as const }
    : task;
}

/** Upstream clients have no schedule to show an event-triggered task as, nor a review agent. */
export const hidesScheduledTask = (task: ScheduledTask, client: ClientWireCapabilities) =>
  (task.schedule.type === "event" && !client.scheduledTaskEventSchedule) ||
  (task.agent?.type === "review" && !client.automations);

const scheduledTaskResultForClient = <Result extends { readonly task: ScheduledTask }>(
  result: Result,
  client: ClientWireCapabilities,
): Result => ({ ...result, task: scheduledTaskForClient(result.task, client) });

/** Response mappers by RPC method; ws.ts applies each to its method's results. */
export const responseForClient = {
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: threadStreamItemForClient,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (
    projection: OrchestrationV2ThreadProjection,
    client: ClientWireCapabilities,
  ) => (client.assistantTextParts ? projection : projectionForClient(projection)),
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (
    result: OrchestrationV2GetTurnItemResult,
    client: ClientWireCapabilities,
  ): OrchestrationV2GetTurnItemResult =>
    client.assistantTextParts || result.item === null
      ? result
      : { item: turnItemForClient(result.item) },
  [WS_METHODS.scheduledTasksSubscribe]: (
    result: ScheduledTaskListResult,
    client: ClientWireCapabilities,
  ): ScheduledTaskListResult =>
    client.scheduledTaskSkippedStatus && client.scheduledTaskEventSchedule && client.automations
      ? result
      : {
          ...result,
          tasks: result.tasks.flatMap((task) =>
            hidesScheduledTask(task, client) ? [] : [scheduledTaskForClient(task, client)],
          ),
        },
  [WS_METHODS.scheduledTasksUpsert]: scheduledTaskResultForClient,
  [WS_METHODS.scheduledTasksSetEnabled]: scheduledTaskResultForClient,
  [WS_METHODS.scheduledTasksSetThreadEnabled]: scheduledTaskResultForClient,
  [WS_METHODS.scheduledTasksRunNow]: scheduledTaskResultForClient,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: scheduledTaskResultForClient,
  // An unauthorized link must be linked again, as an expired one must.
  [WS_METHODS.peerLinksList]: (
    result: { readonly links: ReadonlyArray<PeerLinkSummary> },
    client: ClientWireCapabilities,
  ) =>
    client.peerLinkUnauthorizedStatus
      ? result
      : {
          links: result.links.map((link) =>
            link.status === "unauthorized" ? { ...link, status: "expired" as const } : link,
          ),
        },
};

// Upstream clients print a terminal failure's message and match no tag. This error's message reads
// "Failed to access terminal cwd: <cwd>", so the fork's sentence in `cwd` keeps its text.
const terminalErrorForClient = (
  error: TerminalError,
  client: ClientWireCapabilities,
): TerminalError =>
  isTerminalWorkspaceChangedError(error) && !client.terminalWorkspaceChangedError
    ? new TerminalCwdStatError({ cwd: error.message, cause: error })
    : error;

/** Error mappers by RPC method; terminalManagerForClient applies them. */
export const errorForClient = {
  [WS_METHODS.terminalOpen]: terminalErrorForClient,
  [WS_METHODS.terminalAttach]: terminalErrorForClient,
  [WS_METHODS.terminalObserve]: terminalErrorForClient,
  [WS_METHODS.terminalWrite]: terminalErrorForClient,
  [WS_METHODS.terminalResize]: terminalErrorForClient,
  [WS_METHODS.terminalClear]: terminalErrorForClient,
  [WS_METHODS.terminalClose]: terminalErrorForClient,
};

/** The terminal manager as one connection's RPC handlers see it. */
export function terminalManagerForClient(
  manager: TerminalManager.TerminalManager["Service"],
  client: ClientWireCapabilities,
): TerminalManager.TerminalManager["Service"] {
  if (client.terminalWorkspaceChangedError) return manager;
  const forClient = (error: TerminalError) => terminalErrorForClient(error, client);
  return {
    ...manager,
    open: (...args) => Effect.mapError(manager.open(...args), forClient),
    attachOutputStream: (...args) =>
      Stream.mapError(manager.attachOutputStream(...args), forClient),
    observeStream: (...args) => Effect.mapError(manager.observeStream(...args), forClient),
    resyncStream: (...args) => Effect.mapError(manager.resyncStream(...args), forClient),
    write: (...args) => Effect.mapError(manager.write(...args), forClient),
    resize: (...args) => Effect.mapError(manager.resize(...args), forClient),
    clear: (...args) => Effect.mapError(manager.clear(...args), forClient),
    close: (...args) => Effect.mapError(manager.close(...args), forClient),
  };
}

/**
 * Scheduled tasks as one connection's RPC handlers see them. A client's list never holds a task it
 * cannot show, so it reaches one by id only in a race; it is refused before anything changes.
 */
export function scheduledTasksForClient(
  service: ScheduledTasks.ScheduledTaskService["Service"],
  client: ClientWireCapabilities,
): ScheduledTasks.ScheduledTaskService["Service"] {
  if (client.scheduledTaskEventSchedule && client.automations) return service;
  const refuseHidden = (id: ScheduledTaskId) =>
    Effect.flatMap(service.list(), ({ tasks }) => {
      const task = tasks.find((candidate) => candidate.id === id);
      return task !== undefined && hidesScheduledTask(task, client)
        ? Effect.fail(
            new ScheduledTaskError({
              message:
                "This automation runs on server events or reviews threads, which this app cannot show. Manage it in this server's T3 Code app.",
              taskId: id,
            }),
          )
        : Effect.void;
    });
  return {
    ...service,
    upsert: (input) =>
      input.id === undefined
        ? service.upsert(input)
        : Effect.andThen(refuseHidden(input.id), service.upsert(input)),
    setEnabled: (input) => Effect.andThen(refuseHidden(input.id), service.setEnabled(input)),
    setThreadEnabled: (input) =>
      Effect.andThen(refuseHidden(input.id), service.setThreadEnabled(input)),
    runNow: (input) => Effect.andThen(refuseHidden(input.id), service.runNow(input)),
    delete: (input) => Effect.andThen(refuseHidden(input.id), service.delete(input)),
    rotateWebhookToken: (input) =>
      Effect.andThen(refuseHidden(input.id), service.rotateWebhookToken(input)),
    listRuns: (input) => Effect.andThen(refuseHidden(input.id), service.listRuns(input)),
  };
}

/**
 * Upstream clients' "Turn into project". This server keeps a thread's project and moves it by
 * changing its folder, and it leaves `threadProjectFromScratch` unadvertised so they hide the action.
 */
export const createProjectFromThread = Effect.fail(
  new OrchestrationDispatchCommandError({
    message:
      "This server does not turn threads into projects. Use Change folder in the thread's menu of this server's T3 Code app to move the thread.",
  }),
);
