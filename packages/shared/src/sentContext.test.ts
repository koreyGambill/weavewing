import {
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

import { formatComposerContextReference } from "./composerContextReferences.ts";
import { sentContextBlocks, sentContextSearchSegments } from "./sentContext.ts";

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
    note: "Keep it warm",
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
  terminal: {
    version: 1,
    kind: "terminal",
    contextId: id("terminal_t1"),
    label: "Terminal 1 lines 3-4",
    terminalId: "t1",
    terminalLabel: "Terminal 1",
    lineStart: 3,
    lineEnd: 4,
    text: "  build ok\n  tests ok\n",
  },
  element: {
    version: 1,
    kind: "element",
    contextId: id("element_e1"),
    label: "button",
    ...element,
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
    label: "src/a.ts:4",
    sectionId: "s1",
    sectionTitle: "Changes",
    filePath: "src/a.ts",
    startIndex: 0,
    endIndex: 1,
    rangeLabel: "line 4",
    text: "Rename this",
    diff: "-const a = 1;\n+const b = 1;\n",
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
      text: "The build failed because the cache expired.",
      start: 0,
      end: 10,
      prefix: "",
      suffix: "",
    },
    itemId: TurnItemId.make("item-1"),
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
} satisfies Record<string, KnownComposerContextRecord>;

function blocksFor(records: ReadonlyArray<ComposerContextRecord>) {
  const text = records.map((record) => formatComposerContextReference(record)).join(" ");
  return sentContextBlocks({ text, records });
}

describe("sentContextBlocks", () => {
  it.each([
    [
      "an answer shows the question, choice and note",
      RECORDS.answer,
      "open",
      [
        [null, "Which cache should the build use?\nIt runs on every push."],
        ["Answer", "Shared cache"],
        ["Note", "Keep it warm"],
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
      "a terminal shows its output with leading indentation",
      RECORDS.terminal,
      "expandable",
      [["Terminal 1, lines 3–4", "  build ok\n  tests ok"]],
    ],
    [
      "an element shows its page, selector, source and markup",
      RECORDS.element,
      "expandable",
      [
        ["Page", "Settings"],
        ["URL", "http://localhost:3000/settings"],
        ["Selector", "#save"],
        ["Component", "SaveButton"],
        ["Source", "src/Save.tsx:12:4"],
        ["HTML", '<button id="save">Save</button>'],
        ["Styles", "color: red;"],
      ],
    ],
    [
      "a preview annotation shows its comment, changes and element",
      RECORDS.annotation,
      "expandable",
      [
        ["URL", "http://localhost:3000/"],
        ["Comment", "Make this bigger"],
        ["Targets", "1 element"],
        ["Requested changes", "font-size: 18px\npadding: 8px"],
        ["Selector", "#save"],
        ["Component", "SaveButton"],
        ["Source", "src/Save.tsx:12:4"],
        ["HTML", '<button id="save">Save</button>'],
        ["Styles", "color: red;"],
      ],
    ],
    [
      "a review comment shows its file, range, comment and diff",
      RECORDS.review,
      "expandable",
      [
        ["File", "src/a.ts"],
        ["Range", "Changes · line 4"],
        ["Comment", "Rename this"],
        ["Diff", "-const a = 1;\n+const b = 1;"],
      ],
    ],
    [
      "a response reply shows the opening it replied to",
      RECORDS.response,
      "expandable",
      [["Replying to", "The build failed because the cache expired."]],
    ],
  ] as const)("%s", (_name, record, display, sections) => {
    const [block] = blocksFor([record]);
    expect(block?.display).toBe(display);
    expect(block?.sections.map((entry) => [entry.label, entry.text])).toEqual(sections);
  });

  it("gives no block to kinds with nothing beyond their label", () => {
    expect(
      blocksFor([
        RECORDS.sameTitleThread,
        RECORDS.mention,
        RECORDS.skill,
        RECORDS.environment,
        RECORDS.file,
      ]),
    ).toEqual([]);
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
    const blocks = sentContextBlocks({
      text,
      records: [RECORDS.answer, RECORDS.terminal, unknown],
    });
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
      "Keep it warm",
      "  build ok\n  tests ok",
    ]);
  });
});
