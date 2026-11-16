import {
  formatComposerContextHref,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  ThreadId,
  ArtifactQuestion,
  type ThreadWorkspace,
  type ThreadArtifact,
} from "@t3tools/contracts";

const Row = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  details: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  remaining: Schema.optional(Schema.String),
  userQaNote: Schema.optional(Schema.String),
  recordedByThreadId: Schema.optional(Schema.NullOr(Schema.String)),
  changed: Schema.optional(Schema.String),
  checks: Schema.optional(Schema.String),
  qaSteps: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  ticket: Schema.optional(Schema.NullOr(Schema.String)),
  workId: Schema.optional(Schema.String),
  markdown: Schema.optional(Schema.String),
  html: Schema.optional(Schema.NullOr(Schema.String)),
});
const Rows = Schema.optional(Schema.Array(Row));
export const LegacyWorkspace = Schema.Struct({
  threadId: ThreadId,
  revision: Schema.Number,
  updatedAt: Schema.NullOr(IsoDateTime),
  agentWork: Rows,
  actionItems: Rows,
  verifications: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  designDocuments: Rows,
  questions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        details: Schema.String,
        options: ArtifactQuestion.fields.options,
        recommendedOptionIds: ArtifactQuestion.fields.recommendedOptionIds,
        multiSelect: Schema.Boolean,
        recommendation: Schema.optional(Schema.String),
      }),
    ),
  ),
  decisions: Schema.optional(Schema.Array(Schema.Unknown)),
  contextItems: Schema.optional(Schema.Array(Schema.Unknown)),
  userDraft: Schema.optional(
    Schema.Struct({
      questionAnswers: Schema.Record(
        Schema.String,
        Schema.Struct({ selectedOptionIds: Schema.Array(Schema.String), notes: Schema.String }),
      ),
      actionNotes: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  submissions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        itemIds: Schema.Array(Schema.String),
        submittedAt: IsoDateTime,
        markdown: Schema.optional(Schema.String),
      }),
    ),
  ),
  summaryNotes: Schema.optional(Schema.String),
  childPreamble: Schema.optional(Schema.String),
  designNotes: Schema.optional(Schema.String),
});
const line = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const verificationLine = (record: Record<string, unknown>) =>
  [
    `Verified by ${line(record.verifier) || "unknown"}${record.method ? ` (${line(record.method)})` : ""}${record.testedRevision ? ` on ${line(record.testedRevision)}` : ""}: ${line(record.result) || "unknown"}`,
    ...(["gaps", "details", "evidence"] as const).flatMap((key) =>
      line(record[key]) ? [`${key}: ${line(record[key])}`] : [],
    ),
  ].join("; ");

export function cleanMigratedDetails(
  details: string,
  original?: typeof LegacyWorkspace.Type,
): string {
  return details
    .replace(/^recordedByThreadId:.*(?:\n|$)/gm, "")
    .split("\n\n")
    .flatMap((paragraph) => {
      if (paragraph.trimStart().startsWith("{")) {
        try {
          const record: Record<string, unknown> = JSON.parse(paragraph);
          if (typeof record.workId === "string" && typeof record.verifier === "string") {
            return [
              verificationLine(
                original?.verifications?.find((entry) => entry.id === record.id) ?? record,
              ),
            ];
          }
        } catch {
          /* User details can begin with a brace. */
        }
      }
      return [paragraph];
    })
    .filter(Boolean)
    .join("\n\n");
}

export function migrateWorkspace(old: typeof LegacyWorkspace.Type, now: string): ThreadWorkspace {
  const createdAt = old.updatedAt ?? now;
  const details = (row: typeof Row.Type) =>
    [
      row.details,
      ...(
        [
          ["Changed", row.changed],
          ["Checks", row.checks],
          ["QA steps", row.qaSteps],
          ["Source", row.source],
          ["Remaining", row.remaining],
          ["QA note", row.userQaNote],
        ] as const
      ).flatMap(([label, value]) => (line(value) ? [`${label}: ${line(value)}`] : [])),
    ]
      .filter(Boolean)
      .join("\n\n");
  const items: ThreadWorkspace["items"][number][] = (old.agentWork ?? []).map((row) => ({
    id: row.id,
    text: (row.title || row.id).replace(/[\r\n]+/g, " "),
    state: row.status === "done" || row.status === "landed" ? "done" : "open",
    owner: "agent",
    createdAt,
    doneAt:
      row.completedAt ?? (row.status === "done" || row.status === "landed" ? createdAt : null),
    details: [
      details(row),
      ...(old.verifications ?? []).filter((v) => v.workId === row.id).map(verificationLine),
    ]
      .filter(Boolean)
      .join("\n\n"),
    parentId: null,
    links: row.ticket ? [{ type: "ticket", target: row.ticket }] : [],
  }));
  for (const row of old.actionItems ?? [])
    if (row.status !== "done")
      items.push({
        id: row.id,
        text: (row.title || row.id).replace(/[\r\n]+/g, " "),
        state: "open",
        owner: "you",
        createdAt,
        doneAt: null,
        details: details(row),
        parentId: null,
        links: [],
      });
  const artifact = (id: string, title: string, content: string) => ({
    id,
    title,
    format: "markdown" as const,
    versions: [
      {
        version: 1,
        title,
        format: "markdown" as const,
        content,
        createdAt,
        questions: [],
        answers: {},
      },
    ],
  });
  const artifacts: ThreadWorkspace["artifacts"][number][] = [];
  const privateNotes = Object.entries(old.userDraft?.actionNotes ?? {}).filter(([, note]) =>
    note.trim(),
  );
  if (old.questions?.length || privateNotes.length) {
    const questions = (old.questions ?? []).map(({ title, recommendation, ...question }) => ({
      ...question,
      prompt: title,
      details: [question.details, recommendation].filter(Boolean).join("\n\n"),
    }));
    questions.push(
      ...privateNotes.map(([id]) => ({
        id: `action-note:${id}`,
        prompt: old.actionItems?.find((item) => item.id === id)?.title ?? id,
        details: "",
        options: [],
        recommendedOptionIds: [],
        multiSelect: false,
      })),
    );
    const document = artifact(
      "workspace-questions",
      "Questions",
      questions
        .map((question) => `\`\`\`t3-question\n${JSON.stringify(question, null, 2)}\n\`\`\``)
        .join("\n\n"),
    );
    artifacts.push({
      ...document,
      versions: [
        {
          ...document.versions[0]!,
          questions,
          answers: Object.fromEntries(
            questions.flatMap((question) => {
              const answer = question.id.startsWith("action-note:")
                ? {
                    selectedOptionIds: [],
                    notes: old.userDraft!.actionNotes[question.id.slice("action-note:".length)]!,
                  }
                : old.userDraft?.questionAnswers[question.id];
              return answer
                ? [
                    [
                      question.id,
                      {
                        chosenOptionIds: answer.selectedOptionIds,
                        notes: answer.notes,
                        submittedAt:
                          old.submissions?.findLast(
                            (entry) =>
                              entry.itemIds.includes(question.id) &&
                              entry.markdown?.split("\n\n[").some((block) => {
                                const [heading, ...lines] = block.split("\n");
                                const body = [
                                  `Question: ${question.prompt}`,
                                  ...(answer.selectedOptionIds.length
                                    ? [
                                        `Answer: ${answer.selectedOptionIds.map((id) => question.options.find((option) => option.id === id)?.label ?? id).join("; ")}`,
                                      ]
                                    : []),
                                  ...(answer.notes.trim() ? [`Notes: ${answer.notes.trim()}`] : []),
                                ].join("\n");
                                return (
                                  heading?.endsWith(
                                    `(${formatComposerContextHref("thread", toComposerContextId(`workspace-${question.id}`))})`,
                                  ) && lines.join("\n") === body
                                );
                              }),
                          )?.submittedAt ?? null,
                      },
                    ],
                  ]
                : [];
            }),
          ),
        },
      ],
    });
  }
  const archive = {
    decisions: old.decisions,
    context: old.contextItems,
  };
  if ((old.decisions?.length ?? 0) + (old.contextItems?.length ?? 0))
    artifacts.push(
      artifact(
        "workspace-decisions-context",
        "Decisions & context",
        Object.entries(archive)
          .map(
            ([kind, records]) =>
              `## ${kind === "decisions" ? "Decisions" : "Context"}\n\n\`\`\`json\n${JSON.stringify(records ?? [], null, 2)}\n\`\`\``,
          )
          .join("\n\n"),
      ),
    );
  const designs = [
    ...(old.designDocuments ?? []),
    ...(old.designNotes
      ? [{ id: "legacy-design", title: "Design", markdown: old.designNotes }]
      : []),
  ];
  return {
    threadId: old.threadId,
    revision: old.revision,
    items,
    artifacts: [
      ...artifacts,
      ...designs.map((row): ThreadArtifact => {
        const title = row.title || row.id;
        const markdown = {
          version: 1,
          title,
          format: "markdown" as const,
          content: row.markdown || "",
          createdAt,
          questions: [],
          answers: {},
        };
        const versions = row.html
          ? [
              ...(row.markdown ? [markdown] : []),
              {
                ...markdown,
                version: row.markdown ? 2 : 1,
                format: "html" as const,
                content: row.html,
              },
            ]
          : [markdown];
        return { id: row.id, title, format: row.html ? "html" : "markdown", versions };
      }),
    ],
    summaryNotes: old.summaryNotes ?? "",
    childPreamble: old.childPreamble ?? "",
    updatedAt: old.updatedAt,
  };
}
