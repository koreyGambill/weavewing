import { EnvironmentId, ThreadId, type ThreadWorkspace } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  selectContextThread,
  summarizeThreadTools,
  talkedWithThreads,
  withDelegates,
  threadToolsAttention,
} from "./threadContextSidebar";
import { applyTileAction, syncTileLayout } from "./threadTileLayout";
import { useThreadContextSidebarStore } from "./threadContextSidebarStore";
import { provideSideAreaContext, useToolSidebarStore } from "./toolSidebarStore";

const owner = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("owner") };
const child = { environmentId: owner.environmentId, threadId: ThreadId.make("child") };
const surfaces = [{ id: "side-chat:child", kind: "side-chat", threadId: child.threadId }] as const;

describe("thread context sidebar selection", () => {
  it("follows the active thread through split, floating, maximized and Focus layouts", () => {
    const split = syncTileLayout(undefined, [], ["side-chat:child"], "side-chat:child", true);
    expect(selectContextThread(owner, split, surfaces)).toEqual(child);
    const mainGroup = split.root.kind === "split" ? split.root.first.id : "";
    const main = applyTileAction(split, { type: "focus", groupId: mainGroup });
    expect(selectContextThread(owner, main, surfaces)).toEqual(owner);
    const floating = applyTileAction(split, {
      type: "float-group",
      groupId: "panels-group",
      rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
    });
    expect(selectContextThread(owner, floating, surfaces)).toEqual(child);
    const maximized = applyTileAction(floating, { type: "maximize", groupId: "panels-group" });
    expect(selectContextThread(owner, maximized, surfaces)).toEqual(child);
    const paired = applyTileAction(
      applyTileAction(split, { type: "maximize", groupId: mainGroup }),
      { type: "show-beside", groupId: "panels-group" },
    );
    expect(selectContextThread(owner, paired, surfaces)).toEqual(child);
    const left = applyTileAction(paired, { type: "focus", groupId: mainGroup });
    expect(selectContextThread(owner, left, surfaces)).toEqual(owner);
  });

  it("has no thread without a route", () => {
    expect(selectContextThread(null, null, [])).toBeNull();
  });
});

describe("thread tool signals", () => {
  const workspace = (
    items: ThreadWorkspace["items"],
    artifacts: ThreadWorkspace["artifacts"] = [],
  ): ThreadWorkspace => ({
    threadId: owner.threadId,
    revision: 1,
    items,
    artifacts,
    questions: [],
    summaryNotes: "",
    childPreamble: "",
    updatedAt: null,
  });
  const item = (
    state: ThreadWorkspace["items"][number]["state"],
    linkStates?: ThreadWorkspace["items"][number]["linkStates"],
  ): ThreadWorkspace["items"][number] => ({
    id: `item-${state}`,
    text: state,
    state,
    owner: "agent",
    createdAt: "2026-11-13T00:00:00.000Z",
    doneAt: null,
    details: "",
    parentId: null,
    links: [],
    ...(linkStates ? { linkStates } : {}),
  });

  it("counts the agent's open items, leaving the user's own tasks to the waiting strip", () => {
    const yours = { ...item("open"), id: "item-yours", owner: "you" as const };
    expect(summarizeThreadTools(workspace([item("open"), yours])).listCount).toBe(1);
  });

  it("counts open items, unanswered latest questions and the first ticket state", () => {
    const question = (id: string) => ({
      id,
      prompt: id,
      options: [],
      recommendedOptionIds: [],
      multiSelect: false,
    });
    const signals = summarizeThreadTools(
      workspace(
        [
          item("open", [{ type: "ticket", target: "BW-1", state: "closed", label: "Done" }]),
          item("done"),
          item("dropped"),
        ],
        [
          {
            id: "a",
            title: "A",
            format: "markdown",
            versions: [
              {
                version: 1,
                title: "A",
                format: "markdown",
                content: "",
                createdAt: "2026-11-13T00:00:00.000Z",
                questions: [question("old")],
                answers: {},
              },
              {
                version: 2,
                title: "A",
                format: "markdown",
                content: "",
                createdAt: "2026-11-13T00:00:00.000Z",
                questions: [question("answered"), question("open")],
                answers: {
                  answered: {
                    chosenOptionIds: [],
                    notes: "",
                    submittedAt: "2026-11-13T00:00:00.000Z",
                  },
                },
              },
            ],
          },
        ],
      ),
    );
    expect(signals).toEqual({ listCount: 1, questionCount: 1, ticketState: "closed" });
    expect(summarizeThreadTools(null)).toEqual({
      listCount: 0,
      questionCount: 0,
      ticketState: null,
    });
  });
});

describe("thread tools attention", () => {
  const quiet = { listCount: 0, questionCount: 0, ticketState: null } as const;
  const empty = { unread: 0, severity: null } as const;

  it("shows nothing when nothing needs the user", () => {
    expect(threadToolsAttention(quiet, empty)).toBeNull();
    expect(threadToolsAttention({ ...quiet, ticketState: "open" }, empty)).toBeNull();
    expect(threadToolsAttention(quiet, { unread: 4, severity: "info" })).toBeNull();
  });

  it("raises unread warning and critical notifications at their severity", () => {
    expect(threadToolsAttention(quiet, { unread: 2, severity: "critical" })).toEqual({
      tone: "alert",
      summary: "2 unread notifications",
    });
    expect(
      threadToolsAttention(
        { ...quiet, questionCount: 1 },
        {
          unread: 1,
          severity: "warning",
        },
      ),
    ).toEqual({ tone: "question", summary: "1 unanswered question · 1 unread notification" });
  });

  it("takes its tone from the most urgent signal and lists every one", () => {
    expect(
      threadToolsAttention({ listCount: 3, questionCount: 2, ticketState: "needs_review" }, empty),
    ).toEqual({
      tone: "question",
      summary: "2 unanswered questions · Ticket needs review · 3 open todos",
    });
    expect(threadToolsAttention({ ...quiet, questionCount: 1, listCount: 1 }, empty)).toEqual({
      tone: "question",
      summary: "1 unanswered question · 1 open todo",
    });
    expect(threadToolsAttention({ ...quiet, ticketState: "needs_review" }, empty)?.tone).toBe(
      "review",
    );
    expect(threadToolsAttention({ ...quiet, listCount: 4 }, empty)?.tone).toBe("todo");
  });
});

describe("thread tool views", () => {
  it("lists threads this one talked with, not siblings", () => {
    const shell = (id: string, parent: string | null = null, forkOf?: string) => ({
      id,
      title: id,
      lineage: { parentThreadId: parent },
      forkedFrom: forkOf ? { type: "run", threadId: forkOf } : null,
    });
    const self = shell("self", "lead", "origin");
    const related = talkedWithThreads({
      threadId: "self",
      self,
      shells: [
        self,
        shell("lead"),
        shell("origin"),
        shell("worker", "self"),
        shell("sibling", "lead"),
        shell("copy", null, "self"),
        shell("asker"),
        shell("peer"),
        shell("stranger"),
      ],
      messagedBy: new Set(["asker"]),
      transfers: [{ sourceThreadId: "self", targetThreadId: "peer" }],
    });
    expect(related.map(({ entry, relation }) => [entry.id, relation])).toEqual([
      ["lead", "Delegated this thread"],
      ["origin", "Forked from"],
      ["worker", "Delegated to"],
      ["copy", "Fork"],
      ["asker", "Messaged this thread"],
      ["peer", "Shared context"],
    ]);
  });

  it("adds finished delegates the shell list leaves out, once, and skips remote ones", () => {
    const rows = [
      {
        id: "worker",
        title: "Worker",
        branch: null,
        relation: "Delegated to" as const,
        role: "implementation" as const,
      },
    ];
    expect(
      withDelegates(rows, [
        { childThreadId: "worker", title: "Worker" },
        { childThreadId: "short", title: "Short wait", delegateRole: "review" },
        { childThreadId: "short", title: "Short wait follow-up" },
        { childThreadId: "legacy", title: "Older delegate" },
        { childThreadId: null, title: "Native" },
        { childThreadId: "remote", title: "Remote", remoteChild: {} },
      ]).map((row) => [row.id, row.title, row.relation, row.role]),
    ).toEqual([
      ["worker", "Worker", "Delegated to", "implementation"],
      ["short", "Short wait", "Delegated to", "review"],
      ["legacy", "Older delegate", "Delegated to", null],
    ]);
  });
});

describe("thread views store", () => {
  const reset = () => {
    useThreadContextSidebarStore.setState(useThreadContextSidebarStore.getInitialState());
    useToolSidebarStore.setState(useToolSidebarStore.getInitialState());
  };

  const lockedElsewhere = { locked: child };
  // One row per entry point that opened a rail view: [entry, view, target, side panel before,
  // after]. The owner thread's route is open and the side panel follows it.
  it.each([
    ["palette: open artifacts", "artifacts", {}, {}, { view: "artifacts", locked: null }],
    ["palette: open environments", "environments", {}, {}, { view: "environments" }],
    ["palette: open inbox", "inbox", {}, lockedElsewhere, { view: "inbox", locked: child }],
    ["palette: open automations", "automations", {}, {}, { view: "automations" }],
    ["palette: open evidence", "evidence", {}, {}, { view: "evidence" }],
    [
      "title menu: todos, the followed thread",
      "todos",
      { thread: owner },
      lockedElsewhere,
      { view: "todos", locked: null },
    ],
    [
      "title menu: todos, another thread",
      "todos",
      { thread: child },
      {},
      { view: "todos", locked: child },
    ],
    [
      "title menu: automations, another thread",
      "automations",
      { thread: child },
      {},
      { view: "automations", locked: child },
    ],
    ["automation marker", "automations", {}, {}, { view: "automations" }],
    [
      "notification open",
      "inbox",
      { notification: { environmentId: "local", id: "n1" } },
      {},
      { view: "inbox" },
    ],
    [
      "review reminder, from another thread",
      "artifacts",
      { thread: child, artifactId: "r1", arriving: true },
      {},
      { view: "artifacts", locked: null, arrival: child },
    ],
    [
      "review reminder, on its thread",
      "artifacts",
      { thread: owner, artifactId: "r1", arriving: true },
      lockedElsewhere,
      { view: "artifacts", locked: null, arrival: null },
    ],
    [
      "review panel, reviews button",
      "artifacts",
      { thread: owner },
      lockedElsewhere,
      { view: "artifacts", locked: null },
    ],
    [
      "todos summary inside a locked panel",
      "todos",
      { thread: child },
      lockedElsewhere,
      { view: "todos", locked: child },
    ],
    ["waiting strip row", "todos", { thread: owner }, {}, { view: "todos", locked: null }],
    ["evidence chat row", "evidence", {}, {}, { view: "evidence" }],
    [
      "links: open in environments",
      "environments",
      { thread: child, environmentId: "e" },
      lockedElsewhere,
      { view: "environments", locked: child },
    ],
  ] as const)("opens %s in the side panel", (_entry, view, target, before, after) => {
    reset();
    // The side panel remembers what had focus when it opened.
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("HTMLElement", Object);
    using _context = {
      [Symbol.dispose]: provideSideAreaContext(() => ({ route: owner, selected: owner })),
    };
    useToolSidebarStore.setState(before);
    useThreadContextSidebarStore.getState().show(view, target);
    expect(useToolSidebarStore.getState()).toMatchObject({ open: true, ...after });
    vi.unstubAllGlobals();
  });

  it("opens a view on the item it names", () => {
    reset();
    vi.stubGlobal("document", { activeElement: null });
    vi.stubGlobal("HTMLElement", Object);
    const store = useThreadContextSidebarStore.getState();
    store.show("artifacts", { thread: child, artifactId: "plan" });
    expect(useThreadContextSidebarStore.getState().artifactSelection).toEqual({
      thread: child,
      id: "plan",
    });
    store.show("artifacts", { artifactThread: child, artifactId: "plan" });
    expect(useThreadContextSidebarStore.getState().artifactSelection).toEqual({
      thread: child,
      id: "plan",
    });
    store.show("environments", { thread: child, environmentId: "e" });
    expect(useThreadContextSidebarStore.getState().environmentSelection).toEqual({
      thread: child,
      id: "e",
    });
    store.show("inbox", { notification: { environmentId: "local", id: "n1" } });
    expect(useThreadContextSidebarStore.getState()).toMatchObject({
      inboxTab: "inbox",
      inboxSelection: { kind: "notification", environmentId: "local", id: "n1" },
    });
    vi.unstubAllGlobals();
  });

  it("hands the rail's stored selection to the side panel once and keeps only view choices", () => {
    reset();
    const { migrate, partialize } = useThreadContextSidebarStore.persist.getOptions();
    const rail = {
      view: "timeline",
      lastTool: "timeline",
      hidden: ["inbox"],
      todoScope: "all",
    };
    expect(migrate?.(rail, 2)).toEqual({ todoScope: "all" });
    expect(useToolSidebarStore.getState()).toMatchObject({
      open: true,
      view: "timeline",
      threadView: "timeline",
    });
    useToolSidebarStore.setState(useToolSidebarStore.getInitialState());
    expect(migrate?.({ view: "links", lastTool: "links" }, 1)).toEqual({});
    expect(useToolSidebarStore.getState().open).toBe(false);
    expect(
      Object.keys(partialize!(useThreadContextSidebarStore.getState()) as object).toSorted(),
    ).toEqual(["evidenceCoverageDismissed", "todoFilter", "todoScope", "todoShowClosed"]);
  });
});
