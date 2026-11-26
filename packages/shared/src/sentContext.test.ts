import {
  COMPOSER_CONTEXT_KINDS,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
  THREAD_QUESTIONS_ARTIFACT_ID,
  ThreadId,
  TurnItemId,
  type ComposerContextRecord,
  type KnownComposerContextRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "./composerContextReferences.ts";
import {
  sentContextBlocks,
  sentContextSearchSegments,
  sentContextSections,
} from "./sentContext.ts";

const id = (value: string) => ComposerContextId.make(value);
const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

const element = {
  pageUrl: "http://localhost:3000/settings",
  pageTitle: "Settings",
  tagName: "button",
  selector: "#save",
  htmlPreview: '<button id="save">Save</button>',
  componentName: "SaveButton",
  source: { functionName: null, fileName: "src/Save.tsx", lineNumber: 12, columnNumber: 4 },
  styles: "color: red;",
};

const RECORDS = {
  answer: {
    version: 1,
    kind: "artifact-answer",
    contextId: id("answer_q1"),
    label: "Q1: Pick a cache",
    artifactId: THREAD_QUESTIONS_ARTIFACT_ID,
    questionId: "Q1",
    answerRevision: 0,
    title: "Q1: Pick a cache",
    artifactVersion: 1,
    question: "Which cache should the build use?\nIt runs on every push.",
    choice: "Shared cache",
    // A note that repeats the chip label is still what the user wrote.
    note: "Q1: Pick a cache",
  },
  discuss: {
    version: 1,
    kind: "artifact-answer",
    contextId: id("comment_q2"),
    label: "Q2 · discuss",
    artifactId: THREAD_QUESTION_COMMENTS_ARTIFACT_ID,
    questionId: "Q2",
    answerRevision: 0,
    title: "Q2 · discuss",
    artifactVersion: 1,
    question: "Should retries back off?",
    choice: "",
    note: "What does backoff cost us?",
  },
  otherArtifact: {
    version: 1,
    kind: "artifact-answer",
    contextId: id("answer_plan"),
    label: "Plan review",
    artifactId: "artifact-plan",
    questionId: "step-2",
    answerRevision: 0,
    title: "Plan review",
    artifactVersion: 3,
    question: "Keep step two?",
    choice: "Yes",
    note: "",
  },
  terminal: {
    version: 1,
    kind: "terminal",
    contextId: id("terminal_t1"),
    label: "Terminal 1 lines 3-4",
    terminalId: "t1",
    terminalLabel: "Terminal 1",
    lineStart: 3,
    lineEnd: 4,
    text: "  build ok\n  tests ok\nline outside the selection",
  },
  element: {
    version: 1,
    kind: "element",
    contextId: id("element_e1"),
    label: "button",
    ...element,
    selector: null,
  },
  annotation: {
    version: 1,
    kind: "preview-annotation",
    contextId: id("preview-annotation_a1"),
    label: "Annotation",
    annotationId: "a1",
    pageUrl: "http://localhost:3000/",
    pageTitle: null,
    comment: "Make this bigger",
    targetSummary: "1 element",
    styleChanges: ["font-size: 18px", "padding: 8px"],
    elements: [element],
  },
  review: {
    version: 1,
    kind: "review-comment",
    contextId: id("review-comment_r1"),
    label: "Plan section",
    sectionId: "s1",
    sectionTitle: "Changes",
    filePath: "artifact:plan",
    startIndex: 0,
    endIndex: 1,
    rangeLabel: "line 4",
    text: "Rename this",
    diff: "-const a = 1;\n+const b = 1;\n",
    pullRequest: {
      number: 7,
      title: "Local pull request title",
      url: "http://localhost/pr/7",
      headBranch: "feature",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    },
  },
  response: {
    version: 1,
    kind: "response",
    contextId: id("response_p1"),
    label: "Response",
    citation: {
      version: 1,
      environmentId,
      threadId,
      messageId: MessageId.make("m1"),
      text: "The build   failed\nbecause the cache expired.",
      comment: "A local comment the provider never sees",
      start: 0,
      end: 10,
      prefix: "",
      suffix: "",
    },
    itemId: TurnItemId.make("item-1"),
    subagents: [{ threadId, title: "Cache audit" }],
  },
  thread: {
    version: 1,
    kind: "thread",
    contextId: id("thread_t"),
    label: "Build fix",
    environmentId,
    threadId,
    title: "Fix the nightly build cache",
  },
  sameTitleThread: {
    version: 1,
    kind: "thread",
    contextId: id("thread_same"),
    label: "Fix the build",
    environmentId,
    threadId,
    title: "Fix the build",
  },
  mention: {
    version: 1,
    kind: "mention",
    contextId: id("mention_m"),
    label: "a.ts",
    path: "src/a.ts",
  },
  skill: { version: 1, kind: "skill", contextId: id("skill_s"), label: "Review", name: "review" },
  environment: {
    version: 1,
    kind: "environment",
    contextId: id("environment_e"),
    label: "Laptop",
    environmentId,
  },
  file: {
    version: 1,
    kind: "file",
    contextId: id("file_f"),
    label: "notes.txt",
    attachmentId: "att-1",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
  },
  image: {
    version: 1,
    kind: "image",
    contextId: id("image_i"),
    label: "shot.png",
    attachmentId: "att-2",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 12,
  },
} satisfies Record<string, KnownComposerContextRecord>;

function blocksFor(records: ReadonlyArray<ComposerContextRecord>) {
  const text = records.map((record) => formatComposerContextReference(record)).join(" ");
  return sentContextBlocks({ text, records });
}

const indent = (text: string, depth: number) =>
  text
    .split("\n")
    .map((line) => `${"  ".repeat(depth)}${line}`)
    .join("\n");

/** Each kind once; expandable kinds must show only text the provider projection delivered. */
const PARITY = [
  { record: RECORDS.answer, expandable: true },
  { record: RECORDS.terminal, expandable: true },
  { record: RECORDS.element, expandable: true },
  { record: RECORDS.annotation, expandable: true },
  { record: RECORDS.review, expandable: true },
  { record: RECORDS.response, expandable: true },
  { record: RECORDS.thread, expandable: true },
  { record: RECORDS.mention, expandable: false },
  { record: RECORDS.skill, expandable: false },
  { record: RECORDS.environment, expandable: false },
  { record: RECORDS.file, expandable: false },
  { record: RECORDS.image, expandable: false },
] as const;

describe("sentContextBlocks", () => {
  it("covers every known kind in the parity table", () => {
    expect(new Set(PARITY.map(({ record }) => record.kind))).toEqual(
      new Set(COMPOSER_CONTEXT_KINDS),
    );
  });

  it.each(PARITY.map((row) => [row.record.kind, row] as const))(
    "shows %s only as the provider received it",
    (_kind, { record, expandable }) => {
      const delivered = projectComposerContextForProvider({
        text: formatComposerContextReference(record),
        records: [record],
      });
      const sections = sentContextSections(record);
      expect(sections.length > 0).toBe(expandable);
      for (const section of sections) {
        expect(
          [0, 1, 2].some((depth) => delivered.includes(indent(section.text, depth))),
          `${section.label ?? "(no label)"}: ${section.text}`,
        ).toBe(true);
      }
    },
  );

  it.each([
    [
      "an answer keeps a note equal to the chip label",
      RECORDS.answer,
      "open",
      [
        [null, "Which cache should the build use?\nIt runs on every push."],
        ["Answer", "Shared cache"],
        ["Note", "Q1: Pick a cache"],
      ],
    ],
    [
      "a discussion shows the question and comment",
      RECORDS.discuss,
      "open",
      [
        [null, "Should retries back off?"],
        ["Comment", "What does backoff cost us?"],
      ],
    ],
    [
      "a terminal shows only the selected lines, numbered as sent",
      RECORDS.terminal,
      "expandable",
      [[null, "3 |   build ok\n4 |   tests ok"]],
    ],
    [
      "an element without a selector shows its tag, not an invented selector",
      RECORDS.element,
      "expandable",
      [
        ["URL", "http://localhost:3000/settings"],
        ["Tag", "button"],
        ["Title", "Settings"],
        ["Component", "SaveButton"],
        ["Source", "src/Save.tsx:12:4"],
        ["HTML", '<button id="save">Save</button>'],
        ["Styles", "color: red;"],
      ],
    ],
    [
      "a review comment shows its delivered file, not pull request metadata",
      RECORDS.review,
      "expandable",
      [
        ["File", "artifact:plan"],
        ["Range", "line 4"],
        ["Section", "Changes"],
        ["Comment", "Rename this"],
        ["diff", "-const a = 1;\n+const b = 1;"],
      ],
    ],
    [
      "a response reply shows the opening as sent, without the local comment",
      RECORDS.response,
      "expandable",
      [
        ["About subagent", "Cache audit"],
        ["Replying to", "The build failed because the cache expired."],
      ],
    ],
  ] as const)("%s", (_name, record, display, sections) => {
    const [block] = blocksFor([record]);
    expect(block?.display).toBe(display);
    expect(block?.sections.map((entry) => [entry.label, entry.text])).toEqual(sections);
  });

  it("gives no block to a thread whose title is its chip label", () => {
    expect(blocksFor([RECORDS.sameTitleThread])).toEqual([]);
  });

  it("orders blocks by first reference and skips missing and unknown records", () => {
    const unknown = {
      version: 1,
      kind: "waiting-thing",
      contextId: id("waiting_w"),
      label: "Waiting",
      payload: { text: "hidden" },
    } as const;
    const text = [
      formatComposerContextReference(RECORDS.terminal),
      formatComposerContextReference(unknown),
      formatComposerContextReference(RECORDS.answer),
      formatComposerContextReference({ kind: "terminal", contextId: id("gone"), label: "Gone" }),
      formatComposerContextReference(RECORDS.terminal),
    ].join(" ");
    const blocks = sentContextBlocks({ text, records: [RECORDS.answer, RECORDS.terminal, unknown] });
    expect(blocks.map((block) => block.contextId)).toEqual(["terminal_t1", "answer_q1"]);
  });
});

describe("sentContextSearchSegments", () => {
  it("joins wrapped lines with spaces and keeps preformatted lines", () => {
    const text = [RECORDS.answer, RECORDS.terminal]
      .map((record) => formatComposerContextReference(record))
      .join(" ");
    expect(
      sentContextSearchSegments({
        text,
        context: { records: [RECORDS.answer, RECORDS.terminal] },
      }),
    ).toEqual([
      "Which cache should the build use? It runs on every push.",
      "Shared cache",
      "Q1: Pick a cache",
      "3 |   build ok\n4 |   tests ok",
    ]);
  });
});
