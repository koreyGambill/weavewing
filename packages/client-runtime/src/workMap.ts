import {
  waitingTotal,
  type EnvironmentId,
  type EvidenceLandingSummary,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/**
 * The work map: changes in stage columns, a swimlane per lead, the shared resources the changes
 * wait on, and the one resource holding the most blocked change-hours. Everything here is derived
 * from what the client already holds; the optional inputs are facts no surface reports yet.
 */

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
  | "waiting"
  | "waitingCounts"
  | "pendingBackgroundTasks"
  | "createdAt"
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

/** A landing summary from `evidence.list`, scoped to the environment that recorded it. */
export type WorkMapLanding = Pick<
  EvidenceLandingSummary,
  "id" | "title" | "threadId" | "landedAt" | "qa"
> & {
  readonly environmentId: EnvironmentId;
  /** Present on full landings; lets a landing recorded by a lead find the change it landed. */
  readonly changes?: ReadonlyArray<{ readonly branch?: string | undefined }>;
};

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
  /** When each background task last wrote output, keyed `${environmentId}:${threadId}:${taskId}`. */
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
  readonly darkCores?: number;
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
  /** Blocked items, longest blocked first. */
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

const isRunning = (thread: WorkMapThread) => {
  const status = thread.runtime?.status;
  return (
    status === "preparing" || status === "queued" || status === "starting" || status === "running"
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

// Waiting counts already include an open question; a pending approval adds one when nothing else does.
const userWaitCount = (thread: WorkMapThread) =>
  waitingTotal(thread.waitingCounts) ||
  (thread.hasPendingApprovals || thread.hasPendingUserInput ? 1 : 0);

const userWaitSince = (thread: WorkMapThread) =>
  parse(thread.pendingUserInputAt) ??
  parse(thread.latestRun?.completedAt) ??
  parse(thread.updatedAt) ??
  0;

const completedMs = (thread: WorkMapThread) => parse(thread.latestRun?.completedAt);
const startedMs = (thread: WorkMapThread) =>
  parse(thread.latestRun?.startedAt) ?? parse(thread.latestRun?.requestedAt);

function silentSinceMs(thread: WorkMapThread, input: WorkMapInput): number | null {
  if (isRunning(thread)) return null;
  // A monitor waits for a condition by design, so only commands count as silent runs.
  const commands = thread.pendingBackgroundTasks.filter(
    (task) => task.kind === "command" || task.kind === "background_task",
  );
  if (commands.length === 0) return null;
  // Without per-task output times, the thread's last update is the last progress it saw.
  const progress = Math.max(
    ...commands.map(
      (task) =>
        parse(input.taskOutputAt?.get(`${threadKey(refOf(thread))}:${task.taskId}`)) ??
        parse(thread.updatedAt) ??
        0,
    ),
  );
  return input.now - progress >= SILENT_RUN_MS ? progress : null;
}

function formatWorkMapDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return "under 1 m";
  if (minutes < 90) return `${minutes} m`;
  return `${(ms / HOUR).toFixed(1)} h`;
}

interface ChangeGroup {
  key: string;
  branch: string | null;
  implementers: WorkMapThread[];
  reviewers: WorkMapThread[];
  landing: WorkMapLanding | null;
}

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
    const match = lane.changes.find(
      (change) =>
        (thread.branch !== null && change.branch === thread.branch) ||
        (thread.worktreePath !== null &&
          change.implementers.some((other) => other.worktreePath === thread.worktreePath)),
    );
    if (match !== undefined) return match;
    const change: ChangeGroup = {
      key: `${lane.key}:${thread.branch ?? thread.id}`,
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
      const match =
        lane.changes.find(
          (change) =>
            (reviewer.branch !== null && change.branch === reviewer.branch) ||
            (reviewer.worktreePath !== null &&
              change.implementers.some((impl) => impl.worktreePath === reviewer.worktreePath)),
        ) ?? (lane.changes.length === 1 ? lane.changes[0] : undefined);
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
    const branches = new Set(landing.changes?.flatMap((change) => change.branch ?? []) ?? []);
    const match = lane.changes.find(
      (change) =>
        change.landing === null &&
        ((change.branch !== null && branches.has(change.branch)) ||
          [...change.implementers, ...change.reviewers].some(
            (thread) => threadKey(refOf(thread)) === recorder,
          )),
    );
    if (match !== undefined) {
      match.landing = landing;
    } else {
      lane.changes.push({
        key: `${lane.key}:landing:${landing.id}`,
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
    const laneState = deriveLaneState(lane, laneItems, input, envState);
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

  const waitingOnYou = rankWaitingOnYou(threads, items, input.now);
  const resources = deriveResources(input, items, builtLanes, waitingOnYou, envState);
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
  envState: (id: EnvironmentId) => { connected: boolean; lastSeenAt: string | null },
): WorkMapItem {
  const members = [...change.implementers, ...change.reviewers];
  const primary = change.implementers[0] ?? change.reviewers[0];
  const environmentId = primary?.environmentId ?? lane.leadRef.environmentId;
  const declared = input.declared?.get(change.key);
  const base = {
    key: change.key,
    laneKey: lane.key,
    environmentId,
    title: primary?.title ?? change.landing?.title ?? lane.title,
    branch: change.branch,
    threads: members.map(refOf),
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
    return change.landing.qa.pending > 0
      ? make("your_qa", "evidence", "waits_on_you", "you", landedMs)
      : make("landed", "evidence", "done", null, landedMs);
  }

  const stage = declared?.stage ?? inferStage(change);
  const stageSource = declared?.stage === undefined ? "inferred" : "declared";
  const env = envState(environmentId);
  if (!env.connected) {
    return make(stage, stageSource, "unknown", null, null, null, env.lastSeenAt);
  }

  const askingUser = members.filter((thread) => userWaitCount(thread) > 0);
  if (askingUser.length > 0) {
    return make(
      stage,
      stageSource,
      "waits_on_you",
      "you",
      Math.min(...askingUser.map(userWaitSince)),
    );
  }
  if (members.some(isFailed)) {
    const failedAt = Math.max(...members.filter(isFailed).map((t) => completedMs(t) ?? 0));
    return make(stage, stageSource, "failing", null, failedAt);
  }
  const silent = members.map((thread) => silentSinceMs(thread, input)).filter((ms) => ms !== null);
  if (silent.length > 0) {
    const since = Math.min(...silent);
    return make(
      stage,
      stageSource,
      "blocked",
      `test_slots:${environmentId}`,
      since,
      `silent ${formatWorkMapDuration(input.now - since)}`,
    );
  }
  const lastMs = Math.max(0, ...members.map((thread) => parse(thread.updatedAt) ?? 0));
  if (declared?.blockedOn !== undefined) {
    return make(
      stage,
      stageSource,
      "blocked",
      declared.blockedOn,
      parse(declared.readyAt) ?? lastMs,
    );
  }
  if (members.some(isRunning)) {
    return make(
      stage,
      stageSource,
      "working",
      null,
      Math.max(...members.map((t) => startedMs(t) ?? 0)),
    );
  }
  if (stage === "ready_to_land") {
    const readyMs =
      parse(declared?.readyAt) ?? Math.max(...members.map((thread) => completedMs(thread) ?? 0));
    const waited = input.now - readyMs;
    return make(
      stage,
      stageSource,
      waited > READY_TO_LAND_MS ? "blocked" : "waiting",
      "landing",
      readyMs,
      `waited ${formatWorkMapDuration(waited)} to land`,
    );
  }
  if (stage === "batch_and_verify" && input.main?.red === true) {
    return make(
      stage,
      stageSource,
      "blocked",
      "main",
      parse(declared?.readyAt) ?? lastMs,
      "main is red",
    );
  }
  if (stage === "briefed") {
    return make(
      stage,
      stageSource,
      input.now - lastMs > STALLED_MS ? "stalled" : "not_started",
      null,
      lastMs,
    );
  }
  const waitsOn = stage === "in_review" ? "reviewers" : null;
  return make(
    stage,
    stageSource,
    input.now - lastMs > STALLED_MS ? "stalled" : "waiting",
    waitsOn,
    lastMs,
  );
}

function inferStage(change: ChangeGroup): WorkMapStage {
  const { implementers, reviewers } = change;
  const reviewDoneMs = Math.max(0, ...reviewers.map((thread) => completedMs(thread) ?? 0));
  if (implementers.some(isRunning)) {
    const restartedMs = Math.max(...implementers.map((thread) => startedMs(thread) ?? 0));
    return reviewDoneMs > 0 && reviewDoneMs <= restartedMs ? "fixing" : "implementing";
  }
  if (reviewers.some((thread) => hasRun(thread) && !isFinished(thread) && !isFailed(thread))) {
    return "in_review";
  }
  if (implementers.length > 0 && !implementers.some(hasRun)) return "briefed";
  const members = [...implementers, ...reviewers];
  if (members.length > 0 && members.every(isFinished)) return "ready_to_land";
  if (implementers.length === 0) return "in_review";
  return reviewDoneMs > 0 ? "fixing" : "implementing";
}

function deriveLaneState(
  lane: LaneDraft,
  items: ReadonlyArray<WorkMapItem>,
  input: WorkMapInput,
  envState: (id: EnvironmentId) => { connected: boolean; lastSeenAt: string | null },
): Pick<WorkMapLane, "state" | "sinceMs" | "lastSeenAt"> {
  const env = envState(lane.leadRef.environmentId);
  const lead = lane.lead;
  if (lead === null || !env.connected) {
    return { state: "unknown", sinceMs: null, lastSeenAt: env.lastSeenAt };
  }
  if (userWaitCount(lead) > 0) {
    return { state: "waits_on_you", sinceMs: userWaitSince(lead), lastSeenAt: null };
  }
  if (isRunning(lead)) return { state: "working", sinceMs: startedMs(lead), lastSeenAt: null };
  if (isFailed(lead)) return { state: "failing", sinceMs: completedMs(lead), lastSeenAt: null };

  const pendingChildKeys = lead.pendingBackgroundTasks.flatMap((task) =>
    task.kind === "subagent" && task.childThreadId !== undefined
      ? [threadKey({ environmentId: lead.environmentId, threadId: task.childThreadId })]
      : [],
  );
  const leadWaits =
    lead.runtime?.status === "waiting" ||
    lead.blockedOnThreadWait === true ||
    pendingChildKeys.length > 0;
  if (!leadWaits) {
    return {
      state: items.some((item) => item.state === "working") ? "working" : "idle",
      sinceMs: null,
      lastSeenAt: null,
    };
  }
  // A pending child the shell omits counts as waiting, because shells keep only live children.
  const lastUpdateMs = Math.max(
    ...[lead, ...lane.children].map((thread) => parse(thread.updatedAt) ?? 0),
  );
  const anyWorking = lane.children.some(isRunning);
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
          holds: held.get(key) ?? 0,
        },
      ];
    })
    .sort((a, b) => b.holds - a.holds || a.sinceMs - b.sinceMs || b.count - a.count);
}

function deriveResources(
  input: WorkMapInput,
  items: ReadonlyArray<WorkMapItem>,
  lanes: ReadonlyArray<WorkMapLane>,
  waitingOnYou: ReadonlyArray<WorkMapWaitingThread>,
  envState: (id: EnvironmentId) => { connected: boolean; lastSeenAt: string | null },
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

  const you = load("you");
  // A lead waiting on the user holds its lane's changes, so it counts once beside them.
  const heldLeads = lanes.filter(
    (lane) =>
      lane.state === "waits_on_you" &&
      lane.items.length > 0 &&
      !lane.items.some((item) =>
        item.threads.some((ref) => threadKey(ref) === threadKey(lane.lead)),
      ),
  );
  const leadHours = heldLeads.reduce(
    (sum, lane) => sum + Math.max(0, input.now - (lane.sinceMs ?? input.now)) / HOUR,
    0,
  );
  const openItems = waitingOnYou.reduce((sum, thread) => sum + thread.count, 0);
  const resources: WorkMapResource[] = [
    {
      key: "you",
      kind: "you",
      label: "You",
      state: openItems > 0 ? "busy" : "ok",
      waiting: you.waiting + heldLeads.length,
      blocked: you.blocked + heldLeads.length,
      blockedChangeHours: you.blockedChangeHours + leadHours,
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
    const darkCores = (input.darkWork ?? [])
      .filter((dark) => dark.environmentId === env.environmentId)
      .reduce((sum, dark) => sum + dark.cores, 0);
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
      ...(darkCores > 0 ? { darkCores } : {}),
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
          ? slots.waiting > 0
            ? "busy"
            : "not_measured"
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
    const inFlight = items.filter((item) => item.state !== "done").length;
    if (lanes.length === 0) return "No work in flight.";
    const base = `Nothing is blocked: ${plural(inFlight, "change", "changes")} in flight.`;
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
