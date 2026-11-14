import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerThreadDraftState, DraftSessionState } from "../../composerDraftStore";
import {
  captureRouteDraftRow,
  needsRouteDraftCapture,
  selectSidebarDraftRows,
  type FrozenRouteDraftRow,
} from "./SidebarDraftBlock.logic";

const session = (id: string, createdAt: string): DraftSessionState => ({
  threadId: ThreadId.make(id),
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  logicalProjectKey: "env:project",
  createdAt,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  envMode: "local",
  startFromOrigin: false,
});

const composer = (prompt: string) =>
  ({
    prompt,
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    artifactAnswers: [],
    replyTo: null,
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  }) satisfies ComposerThreadDraftState;

function listed(
  sessions: Record<string, DraftSessionState>,
  composers: Record<string, ComposerThreadDraftState | undefined>,
  routeDraftId: string | null,
  previous: FrozenRouteDraftRow = { routeDraftId: null, row: null },
) {
  const frozen = needsRouteDraftCapture(previous, routeDraftId, sessions)
    ? captureRouteDraftRow(routeDraftId, sessions, composers)
    : previous;
  return {
    frozen,
    ids: selectSidebarDraftRows({
      sessions,
      composers,
      routeDraftId,
      frozen,
      scopedProjectKeys: null,
    }).map((row) => row.draftId as string),
  };
}

describe("sidebar draft rows", () => {
  it("lists a new draft at once and drops it on leaving only while it is untouched", () => {
    const sessions = { a: session("a", "2026-01-01"), b: session("b", "2026-01-02") };
    const opened = listed(sessions, {}, "a");
    expect(opened.ids).toEqual(["a"]);

    expect(listed(sessions, {}, "b").ids).toEqual(["b"]);
    expect(listed(sessions, { a: composer("  ") }, "b").ids).toEqual(["b"]);
    expect(listed(sessions, { a: composer("fix the build") }, "b").ids).toEqual(["b", "a"]);
  });

  it("captures the open draft once its session lands after the route", () => {
    const early = listed({}, {}, "a");
    expect(early.ids).toEqual([]);
    expect(listed({ a: session("a", "2026-01-01") }, {}, "a", early.frozen).ids).toEqual(["a"]);
  });

  it("follows the open draft into another project without repainting while typing", () => {
    const before = { a: session("a", "2026-01-01") };
    const opened = listed(before, {}, "a");
    expect(needsRouteDraftCapture(opened.frozen, "a", before)).toBe(false);
    const moved = { a: { ...before.a, projectId: ProjectId.make("picked") } };
    expect(needsRouteDraftCapture(opened.frozen, "a", moved)).toBe(true);
    expect(captureRouteDraftRow("a", moved, {}).row?.session.projectId).toBe("picked");
  });

  it("keeps a sent draft out and does not recapture it", () => {
    const sessions: Record<string, DraftSessionState> = {
      a: {
        ...session("a", "2026-01-01"),
        promotedTo: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread-a")),
      },
    };
    const sent = listed(sessions, {}, "a");
    expect(sent.ids).toEqual([]);
    expect(needsRouteDraftCapture(sent.frozen, "a", sessions)).toBe(false);
  });
});
