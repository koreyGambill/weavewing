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

/** Which kinds the session has tools for: questions, and the lists and evidence of tasks and QA. */
export interface WaitingKindsAvailable {
  readonly questions: boolean;
  readonly lists: boolean;
}

/**
 * What an agent's turn is told about the items waiting on the user, read from the stores so no
 * display cap can shorten it. A turn without the user's own message gets only the QA problems,
 * and a kind the session has no tools for is left out.
 */
export function waitingContextInput(input: {
  readonly questions: ReadonlyArray<ThreadQuestion>;
  readonly tasks: ReadonlyArray<ListItem>;
  readonly qa: ReadonlyArray<QaForTurn>;
  readonly userTurn: boolean;
  /** The user's previous message; earlier changes went with it. Null takes every change. */
  readonly sinceMs: number | null;
  /** Unset, every kind is available. */
  readonly available?: WaitingKindsAvailable;
}): {
  readonly waiting: ReadonlyArray<WaitingContextItem>;
  readonly changes: ReadonlyArray<WaitingContextChange>;
  readonly problems: ReadonlyArray<WaitingContextProblem>;
} {
  const available = input.available ?? { questions: true, lists: true };
  const questions = available.questions ? input.questions : [];
  const tasks = available.lists ? input.tasks : [];
  const qa = available.lists ? input.qa : [];
  const problems = qa.flatMap((change) =>
    change.state === "problem" ? [{ ref: change.ref, title: change.title, note: change.note }] : [],
  );
  if (!input.userTurn) return { waiting: [], changes: [], problems };
  const userTasks = tasks.flatMap((task) =>
    task.owner === "you" && task.ref !== undefined ? [{ ...task, ref: task.ref }] : [],
  );
  const waiting: ReadonlyArray<WaitingContextItem> = [
    ...questions.flatMap(questionWaiting),
    ...qa.flatMap((change): ReadonlyArray<WaitingContextItem> =>
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
    ...questions.flatMap((question) =>
      after(question.userChangedAt, input.sinceMs)
        ? changed(
            "question",
            question.id,
            threadQuestionTitle(question.prompt),
            QUESTION_CHANGE[question.state],
          )
        : [],
    ),
    ...qa.flatMap((change) =>
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
