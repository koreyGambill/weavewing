import { RunId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { groupContextArchiveEntries } from "./contextArchiveEntries";

it("keeps one disclosure per archive and reveals paged history around a linked entry", () => {
  const first = ThreadId.make("first-archive");
  const second = ThreadId.make("second-archive");
  const runs = [1, 2, 3].map((ordinal) => ({ id: RunId.make(`run-${ordinal}`), ordinal }));
  const entries = runs.map(({ id }): TimelineEntry => ({
    kind: "sent-message",
    id,
    runId: id,
    text: id,
    createdAt: "2026-09-01T00:00:00.000Z",
  }));
  const archives = [
    {
      threadId: second,
      fromRunOrdinal: 2,
      throughRunOrdinal: 2,
      createdAt: "2026-09-03T00:00:00.000Z",
    },
    {
      threadId: first,
      fromRunOrdinal: 1,
      throughRunOrdinal: 1,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  ];
  const input = {
    entries,
    runs,
    archives,
    archiveImportedHistory: false,
    expanded: new Set<ThreadId>(),
    closed: new Set<ThreadId>(),
    revealEntryIds: [],
  };
  expect(groupContextArchiveEntries(input).map((entry) => entry.id)).toEqual([
    `context-archive:${first}`,
    `context-archive:${second}`,
    "run-3",
  ]);
  const linked = { ...input, revealEntryIds: ["run-1"] };
  expect(groupContextArchiveEntries(linked).map((entry) => entry.id)).toEqual([
    `context-archive:${first}`,
    "run-1",
    `context-archive:${second}`,
    "run-3",
  ]);
  expect(groupContextArchiveEntries({ ...linked, closed: new Set([first]) })).toEqual(
    groupContextArchiveEntries(input),
  );
});
