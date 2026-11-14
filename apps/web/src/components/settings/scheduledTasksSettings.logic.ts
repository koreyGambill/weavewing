import {
  isListedThreadLineage,
  isWebhookDedupeTemplate,
  scheduledTaskEventLabel,
  scheduledWakeLabel,
  type ScheduledTaskEventKind,
  type StatusState,
} from "@t3tools/contracts";
import {
  EnvironmentId,
  MAX_EVENT_FILTER_THREADS,
  MAX_GRANT_SUBAGENTS,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskGrant,
  type ScheduledTaskSchedule,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertSchedule,
  scheduledTaskThreadMode,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const ONCE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timeZone?: string,
  runAt?: string | null,
): string {
  const wake = scheduledWakeLabel(schedule);
  if (wake !== null) return wake;
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "event") return scheduledTaskEventLabel(schedule);
  if (schedule.type === "once") return `Once, ${ONCE_FORMATTER.format(new Date(schedule.runAt))}`;
  if (schedule.type === "interval") {
    if (schedule.idleCheckin) return "Idle work check-in · after 30 min idle";
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  const zone = scheduleTimeZoneLabel(timeZone, runAt);
  return `${days} at ${schedule.timeOfDay}${zone === undefined ? "" : ` ${zone}`}`;
}

export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
    ...(raw.new === true || raw.new === "true" ? { new: true as const } : {}),
  };
}

export type ScheduleMode = "fixed" | "once" | "interval" | "webhook" | "idle_checkin" | "event";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly intervalOptions?: Pick<
    Extract<ScheduledTaskUpsertSchedule, { type: "interval" }>,
    "wakeWhen" | "checkin" | "alwaysRun"
  >;
  readonly timeOfDay: string;
  /** Local date and time as a `datetime-local` input value, such as 2026-11-02T15:00. */
  readonly runAt: string;
  /** The stored ISO run time, sent back unchanged when the field was not edited. */
  readonly savedRunAt: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Retain the source selection's provider options when the picker leaves instanceId:model unchanged. */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
  readonly eventKind: ScheduledTaskEventKind;
  readonly eventThreadIds: ReadonlyArray<string>;
  readonly eventIncludeDescendants: boolean;
  /** Match only threads in the task's project. */
  readonly eventProjectOnly: boolean;
  readonly eventStatusSource: string;
  readonly eventToState: StatusState | "";
  readonly eventCooldownSeconds: string;
  readonly eventCoalesceSeconds: string;
  readonly maxRunsPerHour: string;
  readonly maxCostUsd: string;
  readonly maxTokens: string;
  readonly maxSubagents: string;
  /** The stored grant, so a save keeps what the form doesn't edit: `notify`, subagent models. */
  readonly savedGrant: ScheduledTaskGrant | null;
}

export const LIMIT_DRAFT_DEFAULTS = {
  maxRunsPerHour: "",
  maxCostUsd: "",
  maxTokens: "",
  maxSubagents: "",
  savedGrant: null,
} as const;

export const EVENT_DRAFT_DEFAULTS = {
  eventKind: "run_ended",
  eventThreadIds: [],
  eventIncludeDescendants: false,
  eventProjectOnly: true,
  eventStatusSource: "",
  eventToState: "",
  eventCooldownSeconds: "",
  eventCoalesceSeconds: "",
} as const;

function parseWhole(value: string, minimum: number, maximum: number): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Formats a date as a `datetime-local` input value in the browser's time zone. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleDraftErrors(draft: DraftState) {
  if (draft.scheduleMode === "once") {
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime()))
      return [{ title: "Invalid run time", description: "Pick a date and time." }];
    // A time skipped by a daylight saving change parses to a different clock time.
    if (toDateTimeLocalValue(runAt) !== draft.runAt)
      return [
        { title: "Invalid run time", description: "That time does not exist in your time zone." },
      ];
    return [];
  }
  if (draft.scheduleMode === "event") {
    const errors: Array<{ title: string; description: string }> = [];
    if (parseWhole(draft.eventCooldownSeconds, 0, 86_400) === null)
      errors.push({
        title: "Invalid cooldown",
        description: "Enter whole seconds from 0 to 86400, or leave it blank.",
      });
    if (parseWhole(draft.eventCoalesceSeconds, 0, 3600) === null)
      errors.push({
        title: "Invalid coalescing window",
        description: "Enter whole seconds from 0 to 3600, or leave it blank.",
      });
    if (draft.eventThreadIds.length > MAX_EVENT_FILTER_THREADS)
      errors.push({
        title: "Too many threads",
        description: `Watch at most ${MAX_EVENT_FILTER_THREADS} threads.`,
      });
    return errors;
  }
  if (draft.scheduleMode !== "webhook") return [];
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined)
    return [
      {
        title: "Invalid age limit",
        description: `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      },
    ];
  const errors: Array<{ title: string; description: string }> = [];
  for (const [label, value] of [
    ["Duplicate request key", draft.replayKey],
    ["Coalesce key", draft.coalesceKey],
  ] as const) {
    if (value.trim() && !isWebhookDedupeTemplate(value.trim()))
      errors.push({
        title: "Invalid webhook settings",
        description: `${label} must contain a valid request placeholder.`,
      });
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (window && (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600))
    errors.push({
      title: "Invalid webhook settings",
      description: "Coalesce window must be whole seconds from 10 to 3600.",
    });
  return errors;
}

export function webhookDeliveryLabel(delivery: {
  readonly outcome: string;
  readonly pendingWindow?: boolean | undefined;
}) {
  if (delivery.outcome === "accepted") return delivery.pendingWindow ? "Opened window" : "Ran";
  const labels: Record<string, string> = {
    dispatch_failed: "Run failed",
    duplicate: "Duplicate",
    coalesced: "Coalesced",
    filtered: "Filtered",
    rejected_signature: "Bad signature",
    disabled: "Task paused",
    rate_limited: "Rate limited",
    expired: "Too old",
  };
  return labels[delivery.outcome] ?? delivery.outcome.replaceAll("_", " ");
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (scheduleDraftErrors(draft).length > 0) return null;
  if (draft.scheduleMode === "once") {
    const saved = draft.savedRunAt ? new Date(draft.savedRunAt) : null;
    if (saved !== null && toDateTimeLocalValue(saved) === draft.runAt)
      return { type: "once", runAt: draft.savedRunAt };
    // A `datetime-local` value has no offset. In an hour that repeats when clocks go
    // back, keep the saved time's offset; otherwise Date reads it as local time.
    const withSavedOffset =
      saved === null
        ? null
        : new Date(Date.parse(`${draft.runAt}Z`) + saved.getTimezoneOffset() * 60_000);
    return {
      type: "once",
      runAt:
        withSavedOffset !== null && toDateTimeLocalValue(withSavedOffset) === draft.runAt
          ? withSavedOffset.toISOString()
          : new Date(draft.runAt).toISOString(),
    };
  }
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (maxDeliveryAgeMinutes === undefined) return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
      maxDeliveryAgeMinutes,
      ...(replayKey || coalesceKey || coalesceWindowSeconds !== undefined
        ? {
            dedupe: {
              ...(replayKey ? { replayKey } : {}),
              ...(coalesceKey ? { coalesceKey } : {}),
              ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }),
            },
          }
        : { dedupe: {} }),
      // Only edited filters are sent; the server keeps the stored ones otherwise.
      ...(webhookFilterDraftsChanged(draft.savedFilters, draft.filters)
        ? { filters: parsedFilters.filters }
        : {}),
    };
  }
  if (draft.scheduleMode === "event") {
    const cooldownSeconds = parseWhole(draft.eventCooldownSeconds, 0, 86_400) ?? undefined;
    const coalesceSeconds = parseWhole(draft.eventCoalesceSeconds, 0, 3600) ?? undefined;
    const timing = {
      ...(cooldownSeconds === undefined ? {} : { cooldownSeconds }),
      ...(coalesceSeconds === undefined ? {} : { coalesceSeconds }),
    };
    if (draft.eventKind === "status_transition") {
      const statusSource = draft.eventStatusSource.trim();
      return {
        type: "event",
        event: draft.eventKind,
        ...(statusSource ? { statusSource } : {}),
        ...(draft.eventToState ? { toState: draft.eventToState } : {}),
        ...timing,
      };
    }
    const threadIds = draft.eventThreadIds.map((id) => id as ThreadId);
    return {
      type: "event",
      event: draft.eventKind,
      ...(draft.eventProjectOnly && draft.projectId
        ? { projectId: draft.projectId as ProjectId }
        : {}),
      ...(threadIds.length > 0 ? { threadIds } : {}),
      ...(threadIds.length > 0 && draft.eventIncludeDescendants
        ? { includeDescendants: true }
        : {}),
      ...timing,
    };
  }
  if (draft.scheduleMode === "idle_checkin")
    return { ...draft.intervalOptions, type: "interval", everyMs: 1_800_000, idleCheckin: true };
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { ...draft.intervalOptions, type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const filters = webhookFilterDrafts(schedule.type === "webhook" ? schedule.filters : undefined);
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    ...(schedule.type === "interval" ? { intervalOptions: schedule } : {}),
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode:
      schedule.type === "interval" && schedule.idleCheckin
        ? "idle_checkin"
        : schedule.type === "fixed_time"
          ? "fixed"
          : schedule.type,
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    // A time input shows nothing for an unpadded hour such as 9:05, which agents may save.
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay.padStart(5, "0") : "09:00",
    runAt: schedule.type === "once" ? toDateTimeLocalValue(new Date(schedule.runAt)) : "",
    savedRunAt: schedule.type === "once" ? schedule.runAt : "",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    threadMode: scheduledTaskThreadMode(task),
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    replayKey: schedule.type === "webhook" ? (schedule.dedupe?.replayKey ?? "") : "",
    coalesceKey: schedule.type === "webhook" ? (schedule.dedupe?.coalesceKey ?? "") : "",
    coalesceWindowSeconds:
      schedule.type === "webhook" && schedule.dedupe?.coalesceWindowSeconds !== undefined
        ? String(schedule.dedupe.coalesceWindowSeconds)
        : "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    filters,
    savedFilters: filters,
    ...(schedule.type === "event"
      ? {
          eventKind: schedule.event,
          eventThreadIds: schedule.threadIds ?? [],
          eventIncludeDescendants: schedule.includeDescendants === true,
          eventProjectOnly: schedule.projectId !== undefined,
          eventStatusSource: schedule.statusSource ?? "",
          eventToState: schedule.toState ?? "",
          eventCooldownSeconds:
            schedule.cooldownSeconds === undefined ? "" : String(schedule.cooldownSeconds),
          eventCoalesceSeconds:
            schedule.coalesceSeconds === undefined ? "" : String(schedule.coalesceSeconds),
        }
      : EVENT_DRAFT_DEFAULTS),
    maxRunsPerHour: optionalText(task.grant?.maxRunsPerHour),
    maxCostUsd: optionalText(task.grant?.budget?.maxCostUsd),
    maxTokens: optionalText(task.grant?.budget?.maxTokens),
    maxSubagents: optionalText(task.grant?.subagents?.max),
    savedGrant: task.grant ?? null,
  };
}

const optionalText = (value: number | undefined) => (value === undefined ? "" : String(value));

function parseCost(value: string): number | null | undefined {
  const trimmed = value.trim().replace(/^\$/, "");
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0.01 && parsed <= 50 ? parsed : null;
}

export function limitsDraftErrors(draft: DraftState) {
  const errors: Array<{ title: string; description: string }> = [];
  if (parseCost(draft.maxCostUsd) === null)
    errors.push({ title: "Invalid cost limit", description: "Enter dollars from 0.01 to 50." });
  if (parseWhole(draft.maxTokens, 1, Number.MAX_SAFE_INTEGER) === null)
    errors.push({ title: "Invalid token limit", description: "Enter a whole number of tokens." });
  if (parseWhole(draft.maxSubagents, 0, MAX_GRANT_SUBAGENTS) === null)
    errors.push({
      title: "Invalid subagent limit",
      description: `Enter whole subagents from 0 to ${MAX_GRANT_SUBAGENTS}.`,
    });
  if (parseWhole(draft.maxRunsPerHour, 1, 120) === null)
    errors.push({ title: "Invalid run limit", description: "Enter whole runs from 1 to 120." });
  return errors;
}

/** The grant to save, or null to remove it. Blank fields set no limit. */
export function grantFromDraft(draft: DraftState): ScheduledTaskGrant | null {
  const maxCostUsd = parseCost(draft.maxCostUsd) ?? undefined;
  const maxTokens = parseWhole(draft.maxTokens, 1, Number.MAX_SAFE_INTEGER) ?? undefined;
  const maxSubagents = parseWhole(draft.maxSubagents, 0, MAX_GRANT_SUBAGENTS) ?? undefined;
  const maxRunsPerHour = parseWhole(draft.maxRunsPerHour, 1, 120) ?? undefined;
  const saved = draft.savedGrant;
  const grant: ScheduledTaskGrant = {
    ...(saved?.notify === undefined ? {} : { notify: saved.notify }),
    ...(maxSubagents === undefined
      ? {}
      : { subagents: { max: maxSubagents, models: saved?.subagents?.models ?? [] } }),
    ...(maxCostUsd === undefined && maxTokens === undefined
      ? {}
      : {
          budget: {
            ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
          },
        }),
    ...(maxRunsPerHour === undefined ? {} : { maxRunsPerHour }),
  };
  return Object.keys(grant).length === 0 ? null : grant;
}

export function moveDraftToThread(
  draft: DraftState,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): DraftState {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: DraftState): DraftState {
  if (!draft.threadId) return draft;
  return {
    ...draft,
    threadId: "",
    ...(draft.workspaceMode === "root"
      ? { workspaceMode: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(draft: DraftState, projectId: string): DraftState {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId };
}

/** Threads a task can move to. The current one is left out; the picker always shows it. */
export function scheduledTaskDestinationThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<EnvironmentThreadShell> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection]) {
    if (
      selection &&
      available.some(
        (entry) =>
          entry.instanceId === selection.instanceId &&
          entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
      )
    )
      return selection;
  }
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}

/**
 * A new task's project: a pinned open project, then any open one. An archived
 * project only when Settings is scoped to it, so that scope can still save.
 */
export function defaultScheduledTaskProjectId<
  TProject extends {
    readonly id: ProjectId;
    readonly pinnedAt?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(scopedProjects: ReadonlyArray<TProject>, scope: ResolvedSettingsScope): ProjectId | "" {
  const open = scopedProjects.filter((project) => project.archivedAt == null);
  const scopedToProject = scope.kind === "project" || scope.kind === "checkout";
  return (
    (
      open.find((project) => project.pinnedAt != null) ??
      open[0] ??
      (scopedToProject ? scopedProjects[0] : undefined)
    )?.id ?? ""
  );
}
