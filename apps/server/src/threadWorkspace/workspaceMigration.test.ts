import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ThreadWorkspace, parseArtifactQuestions } from "@t3tools/contracts";
import fixture from "./testdata/legacy-workspace.json" with { type: "json" };
import { LegacyWorkspace, migrateWorkspace } from "./workspaceMigration.ts";

const decodeLegacy = Schema.decodeSync(LegacyWorkspace);
const decodeWorkspace = Schema.decodeSync(ThreadWorkspace);

it("migrates real-shaped Workspace records without losing verification or question drafts", () => {
  const migrated = migrateWorkspace(
    decodeLegacy({
      ...fixture,
      designDocuments: [
        ...fixture.designDocuments,
        {
          id: "both",
          title: "Both formats",
          markdown: "# Source markdown",
          html: "<h1>Rendered HTML</h1>",
        },
      ],
    }),
    "2026-11-09T00:00:00.000Z",
  );
  expect(decodeWorkspace(migrated)).toEqual(migrated);
  expect(migrated.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "work-1",
        owner: "agent",
        state: "done",
        links: [{ type: "ticket", target: "BW-1" }],
      }),
      expect.objectContaining({ id: "action-1", owner: "you", state: "open" }),
    ]),
  );
  const details = migrated.items.find((item) => item.id === "work-1")!.details;
  for (const value of [
    "Original work source",
    "Remaining validation",
    "QA needs mobile",
    "Implementation details",
    "Changed parser",
    "Two tests passed",
    "Open sample",
    "reviewer",
    "abc123",
    "partial",
    "Mobile untested",
    "/evidence/sample.txt",
    "Verified sample behavior",
  ])
    expect(details).toContain(value);
  expect(details).toContain(
    "Verified by reviewer (executed) on abc123: partial; gaps: Mobile untested",
  );
  expect(details).not.toContain("recordedByThreadId");
  expect(details).not.toContain('"workId"');
  const questions = migrated.artifacts.find((artifact) => artifact.id === "workspace-questions")!
    .versions[0]!;
  expect(parseArtifactQuestions(questions.content)).toEqual(questions.questions);
  expect(questions.content).not.toContain("Private action note");
  expect(questions.answers).toEqual({
    "question-1": {
      chosenOptionIds: ["safe"],
      notes: "Submitted note",
      submittedAt: "2026-11-02T00:00:00.000Z",
    },
    "question-2": { chosenOptionIds: ["fast"], notes: "Private draft note", submittedAt: null },
    "action-note:action-1": {
      chosenOptionIds: [],
      notes: "Private action note",
      submittedAt: null,
    },
  });
  expect(
    migrated.artifacts.find((artifact) => artifact.id === "design-1")?.versions[0]?.content,
  ).toBe("# Sample design");
  expect(
    migrated.artifacts.find((artifact) => artifact.title === "Decisions & context")?.versions[0]
      ?.content,
  ).not.toContain("Private action note");
  expect(migrated.artifacts.find((artifact) => artifact.id === "both")).toMatchObject({
    format: "html",
    versions: [
      { version: 1, format: "markdown", content: "# Source markdown" },
      { version: 2, format: "html", content: "<h1>Rendered HTML</h1>" },
    ],
  });
  expect(migrated.items.some((item) => item.id === "workspace-archive")).toBe(false);
  expect(migrated.childPreamble).toBe("Follow sample constraints");
});
