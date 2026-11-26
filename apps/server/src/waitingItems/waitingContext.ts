import { threadQuestionTitle, type ListItem, type ThreadQuestion } from "@t3tools/contracts";
import type {
  WaitingContextChange,
  WaitingContextItem,
  WaitingContextProblem,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import type { QaForTurn } from "../evidence/EvidenceService.ts";

const after = (at: string | undefined, sinceMs: number | null) => {
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return !Number.isNaN(ms) && (sinceMs === null || ms > sinceMs);
};

const questionWaiting = (question: ThreadQuestion): ReadonlyArray<WaitingContextItem> => {
  if (question.state !== "open" && question.state !== "deferred") return [];
  const line = {
    kind: "question" as const,
    ref: question.id,
    title: threadQuestionTitle(question.prompt),
    ...(question.sentInMessageId === undefined ? {} : { sent: true as const }),
  };
  return question.discussedInMessageId === undefined
    ? [{ ...line, state: question.state }]
    : [
        {
          ...line,
          state: "discussing",
          ...(question.state === "deferred" ? { deferred: true as const } : {}),
        },
      ];
};

const QUESTION_CHANGE: Partial<Record<ThreadQuestion["state"], WaitingContextChange["change"]>> = {
  withdrawn: "withdrew",
  deferred: "deferred",
  open: "reopened",
};
const TASK_CHANGE: Partial<Record<ListItem["state"], WaitingContextChange["change"]>> = {
  done: "done",
  dropped: "cancelled",
  open: "reopened",
};
const QA_CHANGE: Partial<Record<QaForTurn["state"], WaitingContextChange["change"]>> = {
  confirmed: "confirmed",
  waived: "dismissed",
  pending: "reopened",
};

/**
 * What an agent's turn is told about the items waiting on the user, read from the stores so no
 * display cap can shorten it. A turn without the user's own message gets only the QA problems.
 */
export function waitingContextInput(input: {
  readonly questions: ReadonlyArray<ThreadQuestion>;
  readonly tasks: ReadonlyArray<ListItem>;
  readonly qa: ReadonlyArray<QaForTurn>;
  readonly userTurn: boolean;
  /** The user's previous message; earlier changes went with it. Null takes every change. */
  readonly sinceMs: number | null;
}): {
  readonly waiting: ReadonlyArray<WaitingContextItem>;
  readonly changes: ReadonlyArray<WaitingContextChange>;
  readonly problems: ReadonlyArray<WaitingContextProblem>;
} {
  const problems = input.qa.flatMap((change) =>
    change.state === "problem" ? [{ ref: change.ref, title: change.title, note: change.note }] : [],
  );
  if (!input.userTurn) return { waiting: [], changes: [], problems };
  const userTasks = input.tasks.flatMap((task) =>
    task.owner === "you" && task.ref !== undefined ? [{ ...task, ref: task.ref }] : [],
  );
  const waiting: ReadonlyArray<WaitingContextItem> = [
    ...input.questions.flatMap(questionWaiting),
    ...input.qa.flatMap((change): ReadonlyArray<WaitingContextItem> =>
      change.state === "pending"
        ? [
            {
              kind: "qa",
              ref: change.ref,
              title: change.title,
              state: change.discussed ? "discussing" : "open",
            },
          ]
        : [],
    ),
    ...userTasks.flatMap((task): ReadonlyArray<WaitingContextItem> =>
      task.state === "open"
        ? [
            {
              kind: "task",
              ref: task.ref,
              title: threadQuestionTitle(task.text),
              state: task.discussedInMessageId === undefined ? "open" : "discussing",
            },
          ]
        : [],
    ),
  ];
  const changed = (
    kind: WaitingContextChange["kind"],
    ref: string,
    title: string,
    change: WaitingContextChange["change"] | undefined,
  ): ReadonlyArray<WaitingContextChange> =>
    change === undefined ? [] : [{ kind, ref, title, change }];
  const changes = [
    ...input.questions.flatMap((question) =>
      after(question.userChangedAt, input.sinceMs)
        ? changed(
            "question",
            question.id,
            threadQuestionTitle(question.prompt),
            QUESTION_CHANGE[question.state],
          )
        : [],
    ),
    ...input.qa.flatMap((change) =>
      change.by === "user" && after(change.updatedAt, input.sinceMs)
        ? changed("qa", change.ref, change.title, QA_CHANGE[change.state])
        : [],
    ),
    ...userTasks.flatMap((task) =>
      after(task.userChangedAt, input.sinceMs)
        ? changed("task", task.ref, threadQuestionTitle(task.text), TASK_CHANGE[task.state])
        : [],
    ),
  ];
  return { waiting, changes, problems };
}
