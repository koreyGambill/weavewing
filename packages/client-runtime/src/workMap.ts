import {
  waitingTotalWithAnswers,
  type EnvironmentId,
  type EvidenceLandingSummary,
  type ThreadId,
} from "@t3tools/contracts";

import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { EnvironmentThreadShell } from "./state/models.ts";

export type WorkMapStage =
  | "briefed"
  | "implementing"
  | "in_review"
  | "fixing"
  | "ready_to_land"
  | "batch_and_verify"
  | "landed"
  | "your_qa";

const WORK_MAP_STAGES: ReadonlyArray<WorkMapStage> = [
  "briefed",
  "implementing",
  "in_review",
  "fixing",
  "ready_to_land",
  "batch_and_verify",
  "landed",
  "your_qa",
];

export type WorkMapItemState =
  | "working"
  /** Waiting within the stage's normal time. */
  | "waiting"
  | "blocked"
  | "waits_on_you"
  | "failing"
  | "done"
  | "not_started"
  /** Idle past its stage's threshold with no dependency the data can see. */
  | "stalled"
  /** Its environment has no live connection; `lastSeenAt` says when it last reported. */
  | "unknown";

export type WorkMapLaneState =
  | "working"
  | "waiting"
  | "idle"
  /** The lead waits and every pending child waits, with no update for 30 minutes. */
  | "idle_tree"
  | "waits_on_you"
  | "failing"
  | "unknown";

export type WorkMapResourceKind =
  | "you"
  | "main"
  | "landing"
  | "reviewers"
  | "machine"
  | "test_slots";

export type WorkMapResourceState =
  | "ok"
  | "busy"
  | "saturated"
  | "failing"
  | "unknown"
  | "not_measured";

export interface WorkMapThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** The shell fields the map reads; the client's thread shells satisfy it as they are. */
export type WorkMapThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "branch"
  | "worktreePath"
  | "lineage"
  | "delegatedFrom"
  | "delegateRole"
  | "latestRun"
  | "runtime"
  | "blockedOnThreadWait"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingUserInputAt"
  | "waitingCounts"
  | "pendingBackgroundTasks"
  | "updatedAt"
  | "archivedAt"
  | "deletedAt"
>;

export interface WorkMapEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The client holds a live connection, so its threads are current. */
  readonly connected: boolean;
  /** When the environment last reported; the newest thread update stands in when absent. */
  readonly lastSeenAt?: string | null;
  /** Machine load. No surface reports it to the client yet. */
  readonly load?: {
    readonly cores: number;
    readonly load1: number;
    readonly testSlots?: { readonly total: number; readonly busy: number };
  };
}

/**
 * A landing summary from `evidence.list`, scoped to the environment that recorded it. A summary
 * names only its recording thread, so it joins the change that thread belongs to; one a lead
 * recorded shows as its own landed batch.
 */
export type WorkMapLanding = Pick<
  EvidenceLandingSummary,
  "id" | "title" | "threadId" | "landedAt" | "qa" | "changeCount"
> & { readonly environmentId: EnvironmentId };

/** What a lead declares about a change. No surface declares these yet. */
export interface WorkMapDeclaration {
  readonly stage?: WorkMapStage;
  readonly readyAt?: string;
  readonly blockedOn?: WorkMapResourceKey;
}

export interface WorkMapInput {
  readonly now: number;
  readonly threads: ReadonlyArray<WorkMapThread>;
  /** A thread whose environment is not listed reads as unknown. */
  readonly environments: ReadonlyArray<WorkMapEnvironment>;
  readonly landings?: ReadonlyArray<WorkMapLanding>;
  /** Main's health. No surface reports it to the client yet. */
  readonly main?: { readonly red: boolean; readonly knownFailures?: number };
  /** Declarations keyed by `WorkMapItem.key`. */
  readonly declared?: ReadonlyMap<string, WorkMapDeclaration>;
  /**
   * When each background task last wrote output, keyed `${environmentId}:${threadId}:${taskId}`.
   * No surface reports it yet; without it a run can be stalled but never silent.
   */
  readonly taskOutputAt?: ReadonlyMap<string, string>;
  /** Work-like processes no thread or environment owns. No surface reports them yet. */
  readonly darkWork?: ReadonlyArray<WorkMapDarkWork>;
}

export type WorkMapResourceKey =
  | "you"
  | "main"
  | "landing"
  | "reviewers"
  | `machine:${string}`
  | `test_slots:${string}`;

export interface WorkMapItem {
  readonly key: string;
  readonly laneKey: string;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly branch: string | null;
  readonly threads: ReadonlyArray<WorkMapThreadRef>;
  readonly stage: WorkMapStage;
  /** Inferred stages are labeled so until a lead declares them. */
  readonly stageSource: "inferred" | "declared" | "evidence";
  readonly state: WorkMapItemState;
  readonly waitsOn: WorkMapResourceKey | null;
  /** Counts toward its resource's blocked change-hours. */
  readonly blocked: boolean;
  /** Epoch ms the item entered its current state, when known. */
  readonly sinceMs: number | null;
  /** A short cause such as "silent 74 m" or "waited 4.7 h to land". */
  readonly reason: string | null;
  readonly lastSeenAt: string | null;
}

export interface WorkMapLane {
  readonly key: string;
  readonly lead: WorkMapThreadRef;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly state: WorkMapLaneState;
  readonly sinceMs: number | null;
  readonly lastSeenAt: string | null;
  readonly items: ReadonlyArray<WorkMapItem>;
}

export interface WorkMapResource {
  readonly key: WorkMapResourceKey;
  readonly kind: WorkMapResourceKind;
  readonly label: string;
  readonly state: WorkMapResourceState;
  /** Items waiting on it, blocked or not. */
  readonly waiting: number;
  readonly blocked: number;
  readonly blockedChangeHours: number;
  /** Items waiting on the user: questions, QA and tasks, across threads. Set on `you` only. */
  readonly openItems?: number;
  readonly lastSeenAt?: string | null;
  readonly knownFailures?: number;
}

export interface WorkMapWaitingThread {
  /** `${environmentId}:${threadId}`, the key the waiting-on-you list uses. */
  readonly key: string;
  readonly ref: WorkMapThreadRef;
  readonly title: string;
  readonly count: number;
  readonly sinceMs: number;
  /** Changes this thread's open items hold up. */
  readonly holds: number;
}

export interface WorkMapDarkWork {
  readonly environmentId: EnvironmentId;
  readonly command: string;
  readonly cores: number;
}

export interface WorkMapBottleneck {
  readonly resource: WorkMapResourceKey;
  readonly items: ReadonlyArray<string>;
}

export interface WorkMap {
  readonly lanes: ReadonlyArray<WorkMapLane>;
  readonly stageCounts: Readonly<Record<WorkMapStage, number>>;
  readonly resources: ReadonlyArray<WorkMapResource>;
  /** Blocked items, longest blocked first. Stalled items are not blocked: no dependency is known. */
  readonly blocked: ReadonlyArray<WorkMapItem>;
  readonly bottleneck: WorkMapBottleneck | null;
  /** The one sentence at the top of the map. */
  readonly headline: string;
  /** Threads with something waiting on the user, ranked by the changes they hold up. */
  readonly waitingOnYou: ReadonlyArray<WorkMapWaitingThread>;
  readonly dark: ReadonlyArray<WorkMapDarkWork>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SILENT_RUN_MS = 15 * MINUTE;
const IDLE_TREE_MS = 30 * MINUTE;
const STALLED_MS = 30 * MINUTE;
const READY_TO_LAND_MS = 3 * HOUR;
const LANDED_WINDOW_MS = 24 * HOUR;

const threadKey = (ref: { readonly environmentId: string; readonly threadId: string }) =>
  `${ref.environmentId}:${ref.threadId}`;

const refOf = (thread: WorkMapThread): WorkMapThreadRef => ({
  environmentId: thread.environmentId,
  threadId: thread.id,
});

const parse = (iso: string | null | undefined): number | null => {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

function parentKey(thread: WorkMapThread): string | null {
  if (thread.delegatedFrom != null) return threadKey(thread.delegatedFrom);
  if (thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId) {
    return threadKey({
      environmentId: thread.environmentId,
      threadId: thread.lineage.parentThreadId,
    });
  }
  return null;
}

// The server keeps a run `running` while it waits on another thread, so the flag wins.
const isRunning = (thread: WorkMapThread) => {
  const status = thread.runtime?.status;
  return (
    thread.blockedOnThreadWait !== true &&
    (status === "preparing" || status === "queued" || status === "starting" || status === "running")
  );
};

const hasRun = (thread: WorkMapThread) => thread.latestRun !== null || thread.runtime !== null;

const isFailed = (thread: WorkMapThread) =>
  !isRunning(thread) && thread.latestRun?.status === "failed";

const isFinished = (thread: WorkMapThread) =>
  !isRunning(thread) &&
  thread.runtime?.status !== "waiting" &&
  thread.latestRun?.status === "completed" &&
  thread.pendingBackgroundTasks.length === 0;

const pendingRequest = (thread: WorkMapThread) =>
  thread.hasPendingApprovals || thread.hasPendingUserInput ? 1 : 0;

// Waiting counts already include an open question; a pending approval adds one when nothing else does.
const userWaitCount = (thread: WorkMapThread) =>
  waitingTotalWithAnswers(thread.waitingCounts) || pendingRequest(thread);

// QA is about a change that already landed, so only questions and tasks hold work in flight.
const userBlockCount = (thread: WorkMapThread) =>
  (thread.waitingCounts?.question ?? 0) + (thread.waitingCounts?.task ?? 0) ||
  pendingRequest(thread);

const userWaitSince = (thread: WorkMapThread) =>
  parse(thread.pendingUserInputAt) ??
  parse(thread.latestRun?.completedAt) ??
  parse(thread.updatedAt) ??
  0;

const completedMs = (thread: WorkMapThread) => parse(thread.latestRun?.completedAt);
const startedMs = (thread: WorkMapThread) =>
  parse(thread.latestRun?.startedAt) ?? parse(thread.latestRun?.requestedAt);

const awaitedCommands = (thread: WorkMapThread) =>
  thread.pendingBackgroundTasks.filter(
    (task) =>
      (task.kind === "command" || task.kind === "background_task") &&
      backgroundWorkHoldsCompletion([task], {
        awaitUnmarked: thread.lineage.relationshipToParent === "subagent",
      }),
  );

/** When a run's awaited command last wrote output, if it has been silent for 15 minutes. */
function silentSinceMs(thread: WorkMapThread, input: WorkMapInput): number | null {
  if (isRunning(thread)) return null;
  const silent = awaitedCommands(thread).flatMap((task) => {
    const outputMs = parse(input.taskOutputAt?.get(`${threadKey(refOf(thread))}:${task.taskId}`));
    return outputMs !== null && input.now - outputMs >= SILENT_RUN_MS ? [outputMs] : [];
  });
  return silent.length === 0 ? null : Math.min(...silent);
}

function formatWorkMapDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return "under 1 m";
  if (minutes < 90) return `${minutes} m`;
  return `${(ms / HOUR).toFixed(1)} h`;
}

interface ChangeGroup {
  key: string;
  projectId: string;
  branch: string | null;
  implementers: WorkMapThread[];
  reviewers: WorkMapThread[];
  landing: WorkMapLanding | null;
}

const sameChange = (change: ChangeGroup, thread: WorkMapThread) =>
  change.projectId === thread.projectId &&
  (thread.branch !== null
    ? change.branch === thread.branch
    : thread.worktreePath !== null &&
      change.implementers.some(
        (other) =>
          other.environmentId === thread.environmentId &&
          other.worktreePath === thread.worktreePath,
      ));

type EnvState = (environmentId: EnvironmentId) => {
  readonly connected: boolean;
  readonly lastSeenAt: string | null;
};

interface LaneDraft {
  key: string;
  lead: WorkMapThread | null;
  leadRef: WorkMapThreadRef;
  title: string;
  children: WorkMapThread[];
  changes: ChangeGroup[];
}

/** Builds the work map from client-held thread shells and landing summaries. */
export function deriveWorkMap(input: WorkMapInput): WorkMap {
  const environments = new Map(input.environments.map((env) => [env.environmentId, env]));
  const threads = input.threads.filter(
    (thread) => thread.archivedAt === null && thread.deletedAt === null && !thread.lineage.sideChat,
  );
  const byKey = new Map(threads.map((thread) => [threadKey(refOf(thread)), thread]));

  const rootKey = (thread: WorkMapThread): string => {
    let key = threadKey(refOf(thread));
    let parent = parentKey(thread);
    const seen = new Set([key]);
    while (parent !== null && !seen.has(parent)) {
      key = parent;
      seen.add(parent);
      const next = byKey.get(parent);
      parent = next === undefined ? null : parentKey(next);
    }
    return key;
  };

  const lanes = new Map<string, LaneDraft>();
  const laneFor = (key: string, fallback: WorkMapThread): LaneDraft => {
    let lane = lanes.get(key);
    if (lane === undefined) {
      const lead = byKey.get(key) ?? null;
      const leadRef =
        lead !== null
          ? refOf(lead)
          : fallback.delegatedFrom != null
            ? {
                environmentId: fallback.delegatedFrom.environmentId,
                threadId: fallback.delegatedFrom.threadId,
              }
            : refOf(fallback);
      lane = {
        key,
        lead,
        leadRef,
        title: lead?.title ?? fallback.delegatedFrom?.title ?? fallback.title,
        children: [],
        changes: [],
      };
      lanes.set(key, lane);
    }
    return lane;
  };

  const changeFor = (lane: LaneDraft, thread: WorkMapThread): ChangeGroup => {
    const match = lane.changes.find((change) => sameChange(change, thread));
    if (match !== undefined) return match;
    const change: ChangeGroup = {
      key: `${lane.key}:${thread.projectId}:${thread.branch ?? thread.id}`,
      projectId: thread.projectId,
      branch: thread.branch,
      implementers: [],
      reviewers: [],
      landing: null,
    };
    lane.changes.push(change);
    return change;
  };

  for (const thread of threads) {
    const key = rootKey(thread);
    if (key === threadKey(refOf(thread))) {
      laneFor(key, thread);
      continue;
    }
    const lane = laneFor(key, thread);
    lane.children.push(thread);
    if (thread.delegateRole === "implementation") changeFor(lane, thread).implementers.push(thread);
  }

  for (const lane of lanes.values()) {
    for (const reviewer of lane.children.filter((child) => child.delegateRole === "review")) {
      const anonymous = reviewer.branch === null && reviewer.worktreePath === null;
      const match =
        lane.changes.find((change) => sameChange(change, reviewer)) ??
        (anonymous && lane.changes.length === 1 ? lane.changes[0] : undefined);
      (match ?? changeFor(lane, reviewer)).reviewers.push(reviewer);
    }
    // A lead with no implementation children that works on a branch is its own change.
    if (lane.changes.length === 0 && lane.lead !== null && lane.lead.branch !== null) {
      changeFor(lane, lane.lead).implementers.push(lane.lead);
    }
  }

  for (const landing of input.landings ?? []) {
    const landedMs = parse(landing.landedAt) ?? 0;
    if (input.now - landedMs > LANDED_WINDOW_MS && landing.qa.pending === 0) continue;
    const recorder = threadKey({
      environmentId: landing.environmentId,
      threadId: landing.threadId,
    });
    const recordedBy = byKey.get(recorder);
    if (recordedBy === undefined) continue;
    const lane = laneFor(rootKey(recordedBy), recordedBy);
    const match = lane.changes.find(
      (change) =>
        change.landing === null &&
        [...change.implementers, ...change.reviewers].some(
          (thread) => threadKey(refOf(thread)) === recorder,
        ),
    );
    if (match !== undefined) {
      match.landing = landing;
    } else {
      lane.changes.push({
        key: `${lane.key}:landing:${landing.id}`,
        projectId: recordedBy.projectId,
        branch: null,
        implementers: [],
        reviewers: [],
        landing,
      });
    }
  }

  const envState = (environmentId: EnvironmentId) => {
    const env = environments.get(environmentId);
    if (env?.connected === true) return { connected: true, lastSeenAt: null };
    const newest = threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => thread.updatedAt)
      .sort()
      .at(-1);
    return { connected: false, lastSeenAt: env?.lastSeenAt ?? newest ?? null };
  };

  const items: WorkMapItem[] = [];
  const builtLanes: WorkMapLane[] = [];
  for (const lane of lanes.values()) {
    const laneItems = lane.changes.map((change) => deriveItem(lane, change, input, envState));
    const laneState = deriveLaneState(lane, input, envState);
    if (
      laneItems.length === 0 &&
      lane.children.length === 0 &&
      laneState.state !== "waits_on_you"
    ) {
      continue;
    }
    items.push(...laneItems);
    builtLanes.push({
      key: lane.key,
      lead: lane.leadRef,
      title: lane.title,
      environmentId: lane.leadRef.environmentId,
      ...laneState,
      items: laneItems,
    });
  }

  const waitingOnYou = rankWaitingOnYou(
    threads.filter((thread) => envState(thread.environmentId).connected),
    items,
    input.now,
  );
  const resources = deriveResources(input, items, waitingOnYou, envState);
  const bottleneckResource = resources
    .filter((resource) => resource.blockedChangeHours > 0)
    .sort((a, b) => b.blockedChangeHours - a.blockedChangeHours)[0];
  const bottleneck =
    bottleneckResource === undefined
      ? null
      : {
          resource: bottleneckResource.key,
          items: items
            .filter((item) => item.blocked && item.waitsOn === bottleneckResource.key)
            .map((item) => item.key),
        };

  const stageCounts = Object.fromEntries(WORK_MAP_STAGES.map((stage) => [stage, 0])) as Record<
    WorkMapStage,
    number
  >;
  for (const item of items) stageCounts[item.stage] += 1;

  const blocked = items
    .filter((item) => item.blocked)
    .sort((a, b) => (a.sinceMs ?? input.now) - (b.sinceMs ?? input.now));

  return {
    lanes: builtLanes,
    stageCounts,
    resources,
    blocked,
    bottleneck,
    headline: headline(input, items, resources, bottleneckResource, builtLanes),
    waitingOnYou,
    dark: input.darkWork ?? [],
  };
}

function deriveItem(
  lane: LaneDraft,
  change: ChangeGroup,
  input: WorkMapInput,
  envState: EnvState,
): WorkMapItem {
  const primary = change.implementers[0] ?? change.reviewers[0];
  const environmentId = primary?.environmentId ?? lane.leadRef.environmentId;
  const declared = input.declared?.get(change.key);
  const base = {
    key: change.key,
    laneKey: lane.key,
    environmentId,
    title: primary?.title ?? change.landing?.title ?? lane.title,
    branch: change.branch,
    threads: [...change.implementers, ...change.reviewers].map(refOf),
  };
  const make = (
    stage: WorkMapStage,
    stageSource: WorkMapItem["stageSource"],
    state: WorkMapItemState,
    waitsOn: WorkMapResourceKey | null,
    sinceMs: number | null,
    reason: string | null = null,
    lastSeenAt: string | null = null,
  ): WorkMapItem => ({
    ...base,
    stage,
    stageSource,
    state,
    waitsOn,
    blocked: state === "blocked" || (state === "waits_on_you" && stage !== "your_qa"),
    sinceMs,
    reason,
    lastSeenAt,
  });

  if (change.landing !== null) {
    const landedMs = parse(change.landing.landedAt);
    const reason =
      primary === undefined
        ? `landed ${plural(change.landing.changeCount, "change", "changes")}`
        : null;
    return change.landing.qa.pending > 0
      ? make("your_qa", "evidence", "waits_on_you", "you", landedMs, reason)
      : make("landed", "evidence", "done", null, landedMs, reason);
  }

  // Cached threads from an unreachable environment say nothing current about the change.
  const live = {
    implementers: change.implementers.filter((t) => envState(t.environmentId).connected),
    reviewers: change.reviewers.filter((t) => envState(t.environmentId).connected),
  };
  const members = [...live.implementers, ...live.reviewers];
  const stage = declared?.stage ?? inferStage(live);
  const stageSource = declared?.stage === undefined ? "inferred" : "declared";
  if (primary === undefined || !envState(primary.environmentId).connected) {
    // The column is where the change was last seen; the state never claims it is current.
    const lastSeen = declared?.stage ?? inferStage(change);
    const lastSeenAt = envState(environmentId).lastSeenAt;
    return make(lastSeen, stageSource, "unknown", null, null, null, lastSeenAt);
  }

  if (members.some(isRunning)) {
    const startedAt = Math.max(...members.filter(isRunning).map((t) => startedMs(t) ?? 0));
    return make(stage, stageSource, "working", null, startedAt);
  }
  if (members.some(isFailed)) {
    const failedAt = Math.max(...members.filter(isFailed).map((t) => completedMs(t) ?? 0));
    return make(stage, stageSource, "failing", null, failedAt);
  }
  const askingUser = members.filter((thread) => userBlockCount(thread) > 0);
  if (askingUser.length > 0) {
    const since = Math.min(...askingUser.map(userWaitSince));
    return make(stage, stageSource, "waits_on_you", "you", since);
  }
  const silent = members.flatMap((thread) => silentSinceMs(thread, input) ?? []);
  if (silent.length > 0) {
    const since = Math.min(...silent);
    const reason = `silent ${formatWorkMapDuration(input.now - since)}`;
    return make(stage, stageSource, "blocked", `test_slots:${environmentId}`, since, reason);
  }
  const lastMs = Math.max(0, ...members.map((thread) => parse(thread.updatedAt) ?? 0));
  const declaredReadyMs = parse(declared?.readyAt);
  if (declared?.blockedOn !== undefined) {
    return make(stage, stageSource, "blocked", declared.blockedOn, declaredReadyMs ?? lastMs);
  }
  if (stage === "ready_to_land") {
    const readyMs = declaredReadyMs ?? lastMs;
    const state = input.now - readyMs > READY_TO_LAND_MS ? "blocked" : "waiting";
    const reason = `waited ${formatWorkMapDuration(input.now - readyMs)} to land`;
    return make(stage, stageSource, state, "landing", readyMs, reason);
  }
  if (stage === "batch_and_verify" && input.main?.red === true) {
    return make(stage, stageSource, "blocked", "main", declaredReadyMs ?? lastMs, "main is red");
  }
  const stalled = input.now - lastMs > STALLED_MS;
  const quiet =
    stalled && members.some((thread) => awaitedCommands(thread).length > 0)
      ? `quiet ${formatWorkMapDuration(input.now - lastMs)} with a command pending`
      : null;
  if (stage === "briefed") {
    return make(stage, stageSource, stalled ? "stalled" : "not_started", null, lastMs);
  }
  if (stage === "in_review") {
    // A review that finished after the implementer leaves the change with its lead, which has
    // not declared it ready.
    const reviewedMs = reviewedAfterMs(live);
    if (reviewedMs !== null) {
      const reason = `reviewed ${formatWorkMapDuration(input.now - reviewedMs)} ago`;
      return make(stage, stageSource, stalled ? "stalled" : "waiting", null, reviewedMs, reason);
    }
    return make(stage, stageSource, stalled ? "stalled" : "waiting", "reviewers", lastMs, quiet);
  }
  return make(stage, stageSource, stalled ? "stalled" : "waiting", null, lastMs, quiet);
}

const reviewDoneMs = (reviewers: ReadonlyArray<WorkMapThread>) =>
  Math.max(
    0,
    ...reviewers.map((t) => (t.latestRun?.status === "completed" ? (completedMs(t) ?? 0) : 0)),
  );

function reviewedAfterMs(change: Pick<ChangeGroup, "implementers" | "reviewers">): number | null {
  const reviewed = reviewDoneMs(change.reviewers);
  const implemented = Math.max(0, ...change.implementers.map((t) => completedMs(t) ?? 0));
  return reviewed > 0 && reviewed >= implemented ? reviewed : null;
}

/** Ready to land, Batch and verify and their times come only from a declaration. */
function inferStage(change: Pick<ChangeGroup, "implementers" | "reviewers">): WorkMapStage {
  const { implementers, reviewers } = change;
  const reviewedMs = reviewDoneMs(reviewers);
  if (implementers.some(isRunning)) {
    const restartedMs = Math.max(...implementers.map((thread) => startedMs(thread) ?? 0));
    return reviewedMs > 0 && reviewedMs <= restartedMs ? "fixing" : "implementing";
  }
  if (implementers.length === 0) return "in_review";
  if (!implementers.some(hasRun)) return "briefed";
  if (!implementers.every(isFinished)) return reviewedMs > 0 ? "fixing" : "implementing";
  return "in_review";
}

function deriveLaneState(
  lane: LaneDraft,
  input: WorkMapInput,
  envState: EnvState,
): Pick<WorkMapLane, "state" | "sinceMs" | "lastSeenAt"> {
  const env = envState(lane.leadRef.environmentId);
  const lead = lane.lead;
  if (lead === null || !env.connected) {
    return { state: "unknown", sinceMs: null, lastSeenAt: env.lastSeenAt };
  }
  if (isRunning(lead)) return { state: "working", sinceMs: startedMs(lead), lastSeenAt: null };
  if (userBlockCount(lead) > 0) {
    return { state: "waits_on_you", sinceMs: userWaitSince(lead), lastSeenAt: null };
  }
  if (isFailed(lead)) return { state: "failing", sinceMs: completedMs(lead), lastSeenAt: null };

  const leadWaits =
    lead.runtime?.status === "waiting" ||
    lead.blockedOnThreadWait === true ||
    lead.pendingBackgroundTasks.some((task) => task.kind === "subagent");
  const anyWorking = lane.children.some(
    (child) => envState(child.environmentId).connected && isRunning(child),
  );
  if (!leadWaits) {
    return { state: anyWorking ? "working" : "idle", sinceMs: null, lastSeenAt: null };
  }
  // Every child the client holds is checked; a pending child it lacks is idle, because the
  // server sends only live child shells.
  const lastUpdateMs = Math.max(
    ...[lead, ...lane.children].map((thread) => parse(thread.updatedAt) ?? 0),
  );
  if (!anyWorking && input.now - lastUpdateMs >= IDLE_TREE_MS) {
    return { state: "idle_tree", sinceMs: lastUpdateMs, lastSeenAt: null };
  }
  return { state: anyWorking ? "working" : "waiting", sinceMs: null, lastSeenAt: null };
}

function rankWaitingOnYou(
  threads: ReadonlyArray<WorkMapThread>,
  items: ReadonlyArray<WorkMapItem>,
  now: number,
): ReadonlyArray<WorkMapWaitingThread> {
  const held = new Map<string, number>();
  for (const item of items) {
    if (item.waitsOn !== "you" || !item.blocked) continue;
    for (const ref of item.threads) held.set(threadKey(ref), (held.get(threadKey(ref)) ?? 0) + 1);
  }
  const holds = (thread: WorkMapThread) =>
    userBlockCount(thread) > 0 ? (held.get(threadKey(refOf(thread))) ?? 0) : 0;
  return threads
    .flatMap((thread) => {
      const count = userWaitCount(thread);
      if (count === 0) return [];
      const key = threadKey(refOf(thread));
      return [
        {
          key,
          ref: refOf(thread),
          title: thread.title,
          count,
          sinceMs: Math.min(userWaitSince(thread), now),
          holds: holds(thread),
        },
      ];
    })
    .sort((a, b) => b.holds - a.holds || a.sinceMs - b.sinceMs || b.count - a.count);
}

function deriveResources(
  input: WorkMapInput,
  items: ReadonlyArray<WorkMapItem>,
  waitingOnYou: ReadonlyArray<WorkMapWaitingThread>,
  envState: EnvState,
): ReadonlyArray<WorkMapResource> {
  const load = (key: WorkMapResourceKey) => {
    const waiting = items.filter((item) => item.waitsOn === key);
    const blocked = waiting.filter((item) => item.blocked);
    const hours = blocked.reduce(
      (sum, item) => sum + Math.max(0, input.now - (item.sinceMs ?? input.now)) / HOUR,
      0,
    );
    return { waiting: waiting.length, blocked: blocked.length, blockedChangeHours: hours };
  };

  const openItems = waitingOnYou.reduce((sum, thread) => sum + thread.count, 0);
  const resources: WorkMapResource[] = [
    {
      key: "you",
      kind: "you",
      label: "You",
      state: openItems > 0 ? "busy" : "ok",
      ...load("you"),
      openItems,
    },
    {
      key: "main",
      kind: "main",
      label: "Main",
      state: input.main === undefined ? "not_measured" : input.main.red ? "failing" : "ok",
      ...load("main"),
      ...(input.main?.knownFailures === undefined
        ? {}
        : { knownFailures: input.main.knownFailures }),
    },
    {
      key: "landing",
      kind: "landing",
      label: "Landing",
      state: items.some((item) => item.waitsOn === "landing") ? "busy" : "ok",
      ...load("landing"),
    },
    {
      key: "reviewers",
      kind: "reviewers",
      label: "Reviewers",
      state: items.some((item) => item.stage === "in_review" && item.state === "working")
        ? "busy"
        : "ok",
      ...load("reviewers"),
    },
  ];

  for (const env of input.environments) {
    const state = envState(env.environmentId);
    resources.push({
      key: `machine:${env.environmentId}`,
      kind: "machine",
      label: env.label,
      state: !state.connected
        ? "unknown"
        : env.load === undefined
          ? "not_measured"
          : env.load.load1 > env.load.cores
            ? "saturated"
            : "ok",
      ...load(`machine:${env.environmentId}`),
      lastSeenAt: state.lastSeenAt,
    });
    const slotsKey = `test_slots:${env.environmentId}` as const;
    const slots = load(slotsKey);
    if (env.load?.testSlots === undefined && slots.waiting === 0) continue;
    resources.push({
      key: slotsKey,
      kind: "test_slots",
      label: `Test slots on ${env.label}`,
      state:
        env.load?.testSlots === undefined
          ? "busy"
          : env.load.testSlots.busy >= env.load.testSlots.total
            ? "saturated"
            : "ok",
      ...slots,
    });
  }
  return resources;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function headline(
  input: WorkMapInput,
  items: ReadonlyArray<WorkMapItem>,
  resources: ReadonlyArray<WorkMapResource>,
  bottleneck: WorkMapResource | undefined,
  lanes: ReadonlyArray<WorkMapLane>,
): string {
  const unreachable = resources.filter(
    (resource) => resource.kind === "machine" && resource.state === "unknown",
  );
  const unreachableClause = unreachable
    .map(
      (resource) =>
        `${resource.label} is unreachable${
          resource.lastSeenAt == null
            ? ""
            : `, last seen ${formatWorkMapDuration(input.now - (parse(resource.lastSeenAt) ?? input.now))} ago`
        }`,
    )
    .join("; ");

  if (bottleneck === undefined) {
    if (lanes.length === 0) return "No work in flight.";
    const inFlight = items.filter((item) => item.state !== "done").length;
    const stalled = items.filter((item) => item.state === "stalled").length;
    const base = `Nothing is blocked: ${plural(inFlight, "change", "changes")} in flight${
      stalled === 0 ? "" : `, ${stalled} stalled with no known cause`
    }.`;
    return unreachableClause === "" ? base : `${base} ${unreachableClause}.`;
  }

  const blocked = items.filter((item) => item.blocked && item.waitsOn === bottleneck.key);
  const longest = Math.max(0, ...blocked.map((item) => input.now - (item.sinceMs ?? input.now)));
  const total = `${bottleneck.blockedChangeHours.toFixed(1)} h`;
  let sentence: string;
  switch (bottleneck.kind) {
    case "you":
      sentence = `You are the bottleneck: ${plural(bottleneck.openItems ?? 0, "item waits", "items wait")} on you, holding ${plural(bottleneck.blocked, "change", "changes")} for ${total}.`;
      break;
    case "landing":
      sentence = `Landing is the bottleneck: ${plural(blocked.length, "finished change has", "finished changes have")} waited ${total}, the oldest ${formatWorkMapDuration(longest)}.`;
      break;
    case "main":
      sentence = `Main is the bottleneck: it is red${
        bottleneck.knownFailures === undefined
          ? ""
          : ` with ${plural(bottleneck.knownFailures, "known failure", "known failures")}`
      }, holding ${plural(blocked.length, "change", "changes")} for ${total}.`;
      break;
    case "reviewers":
      sentence = `Reviewers are the bottleneck: ${plural(blocked.length, "change has", "changes have")} waited ${total} for review.`;
      break;
    case "test_slots":
      sentence = `${bottleneck.label} are the bottleneck: ${plural(blocked.length, "run has", "runs have")} been silent for ${formatWorkMapDuration(longest)}.`;
      break;
    case "machine":
      sentence = `${bottleneck.label} is the bottleneck: ${plural(blocked.length, "change waits", "changes wait")} on it for ${total}.`;
      break;
  }
  return unreachableClause === "" ? sentence : `${sentence} ${unreachableClause}.`;
}
