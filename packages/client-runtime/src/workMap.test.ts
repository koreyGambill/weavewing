import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveWorkMap,
  type WorkMapInput,
  type WorkMapLanding,
  type WorkMapThread,
} from "./workMap.ts";

const NOW = Date.parse("2026-11-26T20:00:00.000Z");
const ago = (minutes: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW - minutes * 60_000));

const PC = EnvironmentId.make("env-pc");
const MAC = EnvironmentId.make("env-mac");
const environments: WorkMapInput["environments"] = [
  { environmentId: PC, label: "PC", connected: true },
  { environmentId: MAC, label: "Mac", connected: false },
];
const pcOnly: WorkMapInput["environments"] = [{ environmentId: PC, label: "PC", connected: true }];

type Status = "none" | "running" | "waiting" | "completed" | "failed";

interface ThreadSpec {
  readonly id: string;
  readonly env?: EnvironmentId;
  readonly project?: string;
  readonly parent?: string;
  readonly parentEnv?: EnvironmentId;
  readonly role?: WorkMapThread["delegateRole"];
  readonly branch?: string;
  readonly status?: Status;
  readonly startedMin?: number;
  readonly completedMin?: number;
  readonly updatedMin?: number;
  readonly questions?: number;
  readonly qa?: number;
  readonly commandTask?: boolean;
  readonly childTasks?: ReadonlyArray<string>;
  /** Shaped as the server sends it: the run stays `running` while it waits on a thread. */
  readonly waitsOnThreads?: boolean;
}

function thread(spec: ThreadSpec): WorkMapThread {
  const env = spec.env ?? PC;
  const status = spec.waitsOnThreads === true ? "running" : (spec.status ?? "none");
  const updatedAt = ago(spec.updatedMin ?? 1);
  const crossEnvironment = spec.parentEnv !== undefined && spec.parentEnv !== env;
  return {
    environmentId: env,
    id: ThreadId.make(spec.id),
    projectId: ProjectId.make(spec.project ?? "project-1"),
    title: spec.id,
    branch: spec.branch ?? null,
    worktreePath: null,
    lineage: {
      parentThreadId:
        spec.parent === undefined || crossEnvironment ? null : ThreadId.make(spec.parent),
      relationshipToParent: spec.parent === undefined || crossEnvironment ? null : "subagent",
      rootThreadId: ThreadId.make(spec.parent ?? spec.id),
    },
    delegatedFrom:
      spec.parent !== undefined && crossEnvironment
        ? {
            environmentId: spec.parentEnv!,
            threadId: ThreadId.make(spec.parent),
            title: spec.parent,
          }
        : null,
    ...(spec.role === undefined ? {} : { delegateRole: spec.role }),
    latestRun:
      status === "none"
        ? null
        : {
            runId: RunId.make(`${spec.id}-run`),
            status,
            requestedAt: ago(spec.startedMin ?? 60),
            startedAt: ago(spec.startedMin ?? 60),
            completedAt:
              status === "completed" || status === "failed" ? ago(spec.completedMin ?? 5) : null,
            assistantMessageId: null,
          },
    runtime:
      status === "none"
        ? null
        : {
            status,
            activeRunId: null,
            providerInstanceId: "codex" as never,
            providerName: null,
            lastError: null,
            updatedAt,
          },
    blockedOnThreadWait: spec.waitsOnThreads ?? false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingUserInputAt: null,
    ...(spec.questions === undefined && spec.qa === undefined
      ? {}
      : { waitingCounts: { question: spec.questions ?? 0, qa: spec.qa ?? 0, task: 0 } }),
    pendingBackgroundTasks: [
      ...(spec.commandTask === true
        ? [{ taskId: `${spec.id}-suite`, kind: "command" as const, command: "vp test run" }]
        : []),
      ...(spec.childTasks ?? []).map((child) => ({
        taskId: `${child}-task`,
        kind: "subagent" as const,
        childThreadId: ThreadId.make(child),
      })),
    ],
    updatedAt,
    archivedAt: null,
    deletedAt: null,
  };
}

const implementer = (id: string, spec: Omit<ThreadSpec, "id" | "parent" | "role"> = {}) =>
  thread({ id, parent: "release-lead", role: "implementation", branch: id, ...spec });
const reviewer = (id: string, branch: string, spec: Omit<ThreadSpec, "id" | "parent" | "role">) =>
  thread({ id, parent: "release-lead", role: "review", branch, ...spec });

type Map = ReturnType<typeof deriveWorkMap>;
const item = (map: Map, title: string) =>
  map.lanes.flatMap((lane) => lane.items).find((entry) => entry.title === title)!;
const lane = (map: Map, title: string) => map.lanes.find((entry) => entry.title === title)!;
const resource = (map: Map, key: string) => map.resources.find((entry) => entry.key === key)!;

// Yesterday at its worst: nine implementers under one lead, a landing steward, a lost Mac link.
const worstThreads: ReadonlyArray<WorkMapThread> = [
  thread({ id: "release-lead", waitsOnThreads: true, updatedMin: 2 }),
  implementer("finished-a", { status: "completed", completedMin: 300, updatedMin: 290 }),
  reviewer("review-a", "finished-a", { status: "completed", completedMin: 282, updatedMin: 282 }),
  implementer("finished-b", { status: "completed", completedMin: 240, updatedMin: 228 }),
  reviewer("review-b", "finished-b", { status: "completed", completedMin: 228, updatedMin: 228 }),
  implementer("building", { status: "running", startedMin: 20 }),
  implementer("fixing", { status: "running", startedMin: 10 }),
  reviewer("review-fixing", "fixing", { status: "completed", completedMin: 15 }),
  implementer("reviewing", { status: "completed", completedMin: 25, updatedMin: 25 }),
  reviewer("review-live", "reviewing", { status: "running", startedMin: 5 }),
  implementer("silent-suite", { status: "waiting", commandTask: true, updatedMin: 74 }),
  implementer("asking", { status: "waiting", questions: 3, updatedMin: 20 }),
  implementer("queued", { updatedMin: 5 }),
  implementer("on-mac", { env: MAC, parentEnv: PC, status: "running", updatedMin: 137 }),
  thread({ id: "steward", parent: "release-lead", status: "running", startedMin: 40 }),
  // A lead waiting on its children, all of them waiting too, quiet for 38 minutes.
  thread({
    id: "quiet-lead",
    waitsOnThreads: true,
    childTasks: ["quiet-a", "quiet-b"],
    updatedMin: 38,
  }),
  thread({
    id: "quiet-a",
    parent: "quiet-lead",
    role: "research",
    status: "waiting",
    updatedMin: 40,
  }),
  thread({
    id: "quiet-b",
    parent: "quiet-lead",
    role: "research",
    status: "waiting",
    updatedMin: 45,
  }),
  // Questions and QA on the user across threads: 3 above, then 7, 4 and 4.
  thread({
    id: "docs-lead",
    branch: "docs",
    status: "waiting",
    questions: 5,
    qa: 2,
    updatedMin: 15,
  }),
  thread({ id: "chat-d", questions: 4, updatedMin: 30 }),
  thread({ id: "chat-e", questions: 4, updatedMin: 50 }),
  // Cached from the Mac before its link dropped; its question is not current.
  thread({
    id: "mac-lead",
    env: MAC,
    branch: "mac-runner",
    status: "waiting",
    questions: 2,
    updatedMin: 137,
  }),
];

describe("deriveWorkMap on yesterday's worst moment, from today's inputs", () => {
  const worst = deriveWorkMap({ now: NOW, threads: worstThreads, environments });

  it("puts the nine implementers in one lead's lane, with reviews joined to their changes", () => {
    expect(
      lane(worst, "release-lead")
        .items.map((entry) => entry.title)
        .sort(),
    ).toEqual(
      [
        "asking",
        "building",
        "finished-a",
        "finished-b",
        "fixing",
        "on-mac",
        "queued",
        "reviewing",
        "silent-suite",
      ].sort(),
    );
    expect(item(worst, "finished-a").threads.map((ref) => ref.threadId)).toEqual([
      "finished-a",
      "review-a",
    ]);
  });

  it("infers each change's stage from its threads", () => {
    expect(
      Object.fromEntries(
        lane(worst, "release-lead").items.map((entry) => [entry.title, entry.stage]),
      ),
    ).toEqual({
      "finished-a": "ready_to_land",
      "finished-b": "ready_to_land",
      building: "implementing",
      fixing: "fixing",
      reviewing: "in_review",
      "silent-suite": "implementing",
      asking: "implementing",
      queued: "briefed",
      "on-mac": "implementing",
    });
    expect(item(worst, "finished-a").stageSource).toBe("inferred");
  });

  it("shows two finished changes waiting to land as stalled, because no one declared them ready", () => {
    expect(item(worst, "finished-a")).toMatchObject({
      state: "stalled",
      waitsOn: "landing",
      blocked: false,
      reason: "waited 4.7 h to land",
    });
    expect(item(worst, "finished-b")).toMatchObject({
      state: "stalled",
      reason: "waited 3.8 h to land",
    });
  });

  it("marks a lead idle when it and every pending child wait with no update for 30 minutes", () => {
    expect(lane(worst, "quiet-lead")).toMatchObject({
      state: "idle_tree",
      sinceMs: NOW - 38 * 60_000,
    });
    expect(lane(worst, "release-lead").state).toBe("working");
  });

  it("calls a quiet run with a pending command stalled until its output time is known", () => {
    expect(item(worst, "silent-suite")).toMatchObject({
      state: "stalled",
      blocked: false,
      reason: "quiet 74 m with a command pending",
    });
    expect(worst.resources.some((entry) => entry.kind === "test_slots")).toBe(false);
  });

  it("counts eighteen live items on the user and ranks threads by the changes they hold", () => {
    expect(resource(worst, "you")).toMatchObject({ openItems: 18, blocked: 2 });
    expect(worst.waitingOnYou.map((entry) => [entry.title, entry.count, entry.holds])).toEqual([
      ["asking", 3, 1],
      ["docs-lead", 7, 1],
      ["chat-e", 4, 0],
      ["chat-d", 4, 0],
    ]);
    expect(worst.waitingOnYou[0]!.key).toBe("env-pc:asking");
  });

  it("shows work on an environment with no live connection as unknown, last seen", () => {
    expect(item(worst, "on-mac")).toMatchObject({
      state: "unknown",
      blocked: false,
      lastSeenAt: ago(137),
    });
    expect(lane(worst, "mac-lead")).toMatchObject({ state: "unknown", lastSeenAt: ago(137) });
    expect(resource(worst, "machine:env-mac")).toMatchObject({
      state: "unknown",
      lastSeenAt: ago(137),
    });
  });

  it("names the user as the bottleneck, the only resource the data shows blocking", () => {
    expect(worst.bottleneck?.resource).toBe("you");
    expect(worst.headline).toBe(
      "You are the bottleneck: 18 items wait on you, holding 2 changes for 0.6 h. Mac is unreachable, last seen 2.3 h ago.",
    );
  });

  it("keeps chat threads with nothing in flight off the map and counts stages", () => {
    expect(worst.lanes.map((entry) => entry.title).sort()).toEqual(
      ["chat-d", "chat-e", "docs-lead", "mac-lead", "quiet-lead", "release-lead"].sort(),
    );
    expect(worst.stageCounts).toMatchObject({
      briefed: 1,
      implementing: 6,
      fixing: 1,
      in_review: 1,
      ready_to_land: 2,
    });
  });
});

describe("deriveWorkMap on yesterday's worst moment, with the inputs later steps supply", () => {
  const worst = deriveWorkMap({
    now: NOW,
    threads: worstThreads,
    environments,
    declared: new Map([
      ["env-pc:release-lead:project-1:finished-a", { readyAt: ago(282) }],
      ["env-pc:release-lead:project-1:finished-b", { readyAt: ago(228) }],
    ]),
    taskOutputAt: new Map([["env-pc:silent-suite:silent-suite-suite", ago(74)]]),
  });

  it("blocks declared-ready changes on landing and names landing by blocked change-hours", () => {
    expect(item(worst, "finished-a")).toMatchObject({ state: "blocked", waitsOn: "landing" });
    expect(resource(worst, "landing").blockedChangeHours).toBeCloseTo(8.5, 1);
    // More items wait on the user than on landing, but for fewer hours.
    expect(resource(worst, "you").openItems).toBeGreaterThan(resource(worst, "landing").blocked);
    expect(worst.headline).toBe(
      "Landing is the bottleneck: 2 finished changes have waited 8.5 h, the oldest 4.7 h. Mac is unreachable, last seen 2.3 h ago.",
    );
    expect(worst.blocked.map((entry) => entry.title).slice(0, 2)).toEqual([
      "finished-a",
      "finished-b",
    ]);
  });

  it("blocks a run whose awaited command has written no output for 15 minutes", () => {
    expect(item(worst, "silent-suite")).toMatchObject({
      state: "blocked",
      waitsOn: "test_slots:env-pc",
      reason: "silent 74 m",
    });
    expect(resource(worst, "test_slots:env-pc")).toMatchObject({ waiting: 1, blocked: 1 });
  });
});

const landing = (spec: {
  id: string;
  threadId: string;
  landedMin: number;
  pending: number;
  changeCount?: number;
}): WorkMapLanding => ({
  id: spec.id,
  title: spec.id,
  threadId: ThreadId.make(spec.threadId),
  environmentId: PC,
  landedAt: ago(spec.landedMin),
  changeCount: spec.changeCount ?? 1,
  qa: { pending: spec.pending, quiet: 0, confirmed: 0, problem: 0, waived: 0 },
});

describe("deriveWorkMap on a healthy day", () => {
  const map = deriveWorkMap({
    now: NOW,
    environments: pcOnly,
    threads: [
      thread({ id: "release-lead", status: "running", startedMin: 30 }),
      implementer("alpha", { status: "running", startedMin: 20 }),
      implementer("beta", { status: "running", startedMin: 12 }),
      implementer("gamma", { status: "completed", completedMin: 90, updatedMin: 90 }),
      implementer("delta", { status: "completed", completedMin: 70, updatedMin: 70 }),
      implementer("recent", { status: "completed", completedMin: 30, updatedMin: 30 }),
      reviewer("review-recent", "recent", { status: "completed", completedMin: 20 }),
    ],
    landings: [
      landing({ id: "land-gamma", threadId: "gamma", landedMin: 60, pending: 0 }),
      landing({ id: "land-delta", threadId: "delta", landedMin: 40, pending: 1 }),
      landing({ id: "land-old", threadId: "release-lead", landedMin: 3000, pending: 0 }),
    ],
  });

  it("joins a landing to the change whose thread recorded it", () => {
    expect(item(map, "gamma")).toMatchObject({
      stage: "landed",
      stageSource: "evidence",
      state: "done",
    });
    expect(item(map, "delta")).toMatchObject({
      stage: "your_qa",
      state: "waits_on_you",
      blocked: false,
    });
    expect(map.lanes.flatMap((entry) => entry.items).map((entry) => entry.title)).not.toContain(
      "land-old",
    );
  });

  it("holds a reviewed change that finished recently as waiting to land, not blocked", () => {
    expect(item(map, "recent")).toMatchObject({
      stage: "ready_to_land",
      state: "waiting",
      blocked: false,
    });
  });

  it("names no bottleneck and says what is in flight", () => {
    expect(map.bottleneck).toBeNull();
    expect(map.blocked).toEqual([]);
    expect(map.headline).toBe("Nothing is blocked: 4 changes in flight.");
  });
});

describe("deriveWorkMap on an empty install", () => {
  it("shows no lanes, unmeasured main and an idle user", () => {
    const map = deriveWorkMap({ now: NOW, threads: [], environments: [] });
    expect(map.lanes).toEqual([]);
    expect(map.headline).toBe("No work in flight.");
    expect(map.waitingOnYou).toEqual([]);
    expect(resource(map, "main").state).toBe("not_measured");
    expect(resource(map, "you")).toMatchObject({
      state: "ok",
      openItems: 0,
      blockedChangeHours: 0,
    });
  });
});

describe("deriveWorkMap bottleneck sentence", () => {
  const solo = (spec: Omit<ThreadSpec, "id" | "parent" | "role">) => [
    thread({ id: "release-lead", waitsOnThreads: true }),
    implementer("change", spec),
  ];
  const key = "env-pc:release-lead:project-1:change";

  it.each([
    [
      "you",
      { threads: solo({ status: "waiting", questions: 2, updatedMin: 90 }) },
      "You are the bottleneck: 2 items wait on you, holding 1 change for 1.5 h.",
    ],
    [
      "landing",
      {
        threads: solo({ status: "completed", completedMin: 240, updatedMin: 240 }),
        declared: new Map([[key, { stage: "ready_to_land" as const, readyAt: ago(240) }]]),
      },
      "Landing is the bottleneck: 1 finished change has waited 4.0 h, the oldest 4.0 h.",
    ],
    [
      "main",
      {
        threads: solo({ status: "completed", completedMin: 10 }),
        main: { red: true, knownFailures: 27 },
        declared: new Map([[key, { stage: "batch_and_verify" as const, readyAt: ago(120) }]]),
      },
      "Main is the bottleneck: it is red with 27 known failures, holding 1 change for 2.0 h.",
    ],
    [
      "reviewers",
      {
        threads: solo({ status: "completed", completedMin: 60 }),
        declared: new Map([[key, { blockedOn: "reviewers" as const, readyAt: ago(60) }]]),
      },
      "Reviewers are the bottleneck: 1 change has waited 1.0 h for review.",
    ],
    [
      "test slots",
      {
        threads: solo({ status: "waiting", commandTask: true, updatedMin: 74 }),
        taskOutputAt: new Map([["env-pc:change:change-suite", ago(74)]]),
      },
      "Test slots on PC are the bottleneck: 1 run has been silent for 74 m.",
    ],
    [
      "machine",
      {
        threads: solo({ status: "completed", completedMin: 60 }),
        declared: new Map([[key, { blockedOn: "machine:env-pc" as const, readyAt: ago(48) }]]),
      },
      "PC is the bottleneck: 1 change waits on it for 0.8 h.",
    ],
  ])("names %s", (_name, partial, sentence) => {
    const map = deriveWorkMap({ now: NOW, environments: pcOnly, ...partial });
    expect(map.headline).toBe(sentence);
  });
});

describe("deriveWorkMap edge cases", () => {
  it("keeps a running thread with an async question working, holding nothing", () => {
    const map = deriveWorkMap({
      now: NOW,
      environments: pcOnly,
      threads: [
        thread({ id: "release-lead", status: "running", questions: 1, updatedMin: 120 }),
        implementer("change", { status: "running", questions: 1, startedMin: 5 }),
      ],
    });
    expect(item(map, "change")).toMatchObject({ state: "working", blocked: false });
    expect(lane(map, "release-lead").state).toBe("working");
    expect(resource(map, "you")).toMatchObject({ openItems: 2, blocked: 0, blockedChangeHours: 0 });
    expect(map.bottleneck).toBeNull();
  });

  it("keeps a change in review while its reviewer waits, and ignores a quiet monitor", () => {
    const map = deriveWorkMap({
      now: NOW,
      environments: pcOnly,
      threads: [
        thread({ id: "release-lead", waitsOnThreads: true }),
        implementer("change", { status: "completed", completedMin: 20, updatedMin: 20 }),
        reviewer("review", "change", { status: "waiting", updatedMin: 3 }),
        {
          ...implementer("watcher", { status: "waiting", updatedMin: 60 }),
          pendingBackgroundTasks: [{ taskId: "ci-watch", kind: "monitor" as const }],
        },
      ],
      taskOutputAt: new Map([["env-pc:watcher:ci-watch", ago(60)]]),
    });
    expect(item(map, "change")).toMatchObject({ stage: "in_review", state: "waiting" });
    expect(item(map, "watcher").state).not.toBe("blocked");
  });

  it("awaits review for a finished change no reviewer has finished after", () => {
    const map = deriveWorkMap({
      now: NOW,
      environments: pcOnly,
      threads: [
        thread({ id: "release-lead", waitsOnThreads: true }),
        implementer("change", { status: "completed", completedMin: 10, updatedMin: 10 }),
        reviewer("old-review", "change", { status: "completed", completedMin: 40 }),
      ],
    });
    expect(item(map, "change")).toMatchObject({ stage: "in_review", waitsOn: "reviewers" });
  });

  it("shows a lead-recorded landing as its own batch and leaves its children as they were", () => {
    const map = deriveWorkMap({
      now: NOW,
      environments: pcOnly,
      threads: [
        thread({ id: "release-lead", waitsOnThreads: true }),
        implementer("change", { status: "completed", completedMin: 50, updatedMin: 50 }),
        reviewer("review", "change", { status: "completed", completedMin: 45 }),
      ],
      landings: [
        landing({
          id: "batch",
          threadId: "release-lead",
          landedMin: 10,
          pending: 0,
          changeCount: 2,
        }),
      ],
    });
    expect(item(map, "change").stage).toBe("ready_to_land");
    expect(item(map, "batch")).toMatchObject({ stage: "landed", reason: "landed 2 changes" });
  });

  it("leaves cached requests from an unreachable environment out of the live counts", () => {
    const map = deriveWorkMap({
      now: NOW,
      environments,
      threads: [
        thread({ id: "release-lead", waitsOnThreads: true }),
        implementer("change", { status: "completed", completedMin: 30, updatedMin: 30 }),
        thread({
          id: "mac-review",
          env: MAC,
          parent: "release-lead",
          parentEnv: PC,
          role: "review",
          branch: "change",
          status: "completed",
          completedMin: 20,
        }),
        thread({ id: "mac-chat", env: MAC, status: "waiting", questions: 3 }),
      ],
    });
    expect(map.waitingOnYou).toEqual([]);
    expect(resource(map, "you").openItems).toBe(0);
    // The Mac's finished review cannot make the change ready while the Mac is unreachable.
    expect(item(map, "change")).toMatchObject({ stage: "in_review", state: "waiting" });
  });

  it("keeps same-named branches in different projects, and a reviewer of another branch, apart", () => {
    const map = deriveWorkMap({
      now: NOW,
      environments: pcOnly,
      threads: [
        thread({ id: "release-lead", waitsOnThreads: true }),
        implementer("web-fix", { branch: "fix", project: "web", status: "running" }),
        implementer("cli-fix", { branch: "fix", project: "cli", status: "running" }),
        reviewer("stray-review", "other", { status: "running" }),
      ],
    });
    expect(
      lane(map, "release-lead")
        .items.map((entry) => entry.title)
        .sort(),
    ).toEqual(["cli-fix", "stray-review", "web-fix"]);
  });

  it("treats an environment the caller did not list as unknown", () => {
    const map = deriveWorkMap({
      now: NOW,
      environments: [],
      threads: [thread({ id: "lone", branch: "lone", status: "running", updatedMin: 3 })],
    });
    expect(item(map, "lone")).toMatchObject({ state: "unknown", lastSeenAt: ago(3) });
  });
});
