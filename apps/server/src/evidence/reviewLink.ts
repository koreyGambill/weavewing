import type { EvidenceChange, OrchestrationV2DelegateRole } from "@t3tools/contracts";

/** One delegated task of the lead: a child's first task or a follow-up on the same child. */
export interface DelegatedTask {
  readonly childThreadId: string;
  readonly role: OrchestrationV2DelegateRole | null;
  /** ISO times. A task without a completion time has not finished. */
  readonly startedAt: string;
  readonly completedAt: string | null;
  /** This task's own brief and final message. */
  readonly prompt: string;
  readonly result: string | null;
}

export type ThreadReviewVerdict = "approved" | "changes_requested";

const FINAL_VERDICT = /^verdict: (approved|changes requested)$/i;
// Leading whitespace, quote and list marks, then heading and emphasis marks as well.
const CONTAINER_MARKS = /^(?:\s|>|[-*+]\s|\d+[.)]\s)+/;
const LOOKS_LIKE_VERDICT = /^(?:\s|>|[-*+#_`]|\d+[.)])*verdict\s*[:–—-]/i;
const FENCE = /^(```|~~~)/;

/**
 * The verdict a reviewer's final message states. Only an exact last line, `Verdict: approved` or
 * `Verdict: changes requested`, counts, and only when no other line looks like a verdict and every
 * code fence before it is closed. Anything else is not a confirmed verdict.
 */
export function reviewVerdictFromText(text: string): ThreadReviewVerdict | null {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const lastIndex = lines.findLastIndex((line) => line.trim() !== "");
  if (lastIndex < 0) return null;
  const final = FINAL_VERDICT.exec(lines[lastIndex]!);
  if (final === null) return null;
  const earlier = lines.slice(0, lastIndex);
  if (earlier.some((line) => LOOKS_LIKE_VERDICT.test(line))) return null;
  const fences = earlier.filter((line) => FENCE.test(line.replace(CONTAINER_MARKS, "")));
  if (fences.length % 2 !== 0) return null;
  return final[1]!.toLowerCase() === "approved" ? "approved" : "changes_requested";
}

// Characters Git forbids in a ref name, plus prose punctuation around a name; anything else continues it.
const BOUNDARY = String.raw`\s\x00-\x1f\x7f~^:?*[\\"'\x60(),`;
const BEFORE = `(?<=^|[${BOUNDARY}])`;
const AFTER = `(?=$|[${BOUNDARY}]|\\.(?:\\s|$))`;
const HEX_TOKEN = new RegExp(`${BEFORE}[0-9a-fA-F]{7,64}${AFTER}`, "g");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` names `ref` as a whole token, not as part of a longer ref name. */
function namesRef(text: string, ref: string): boolean {
  return new RegExp(`${BEFORE}${escapeRegExp(ref)}${AFTER}`).test(text);
}

type ChangeScope = Pick<EvidenceChange, "branch" | "commits">;

function namesChange(prompt: string, change: ChangeScope, targetBranch: string): boolean {
  const branch = change.branch;
  if (branch !== undefined && branch !== targetBranch && namesRef(prompt, branch)) return true;
  const tokens = (prompt.match(HEX_TOKEN) ?? []).map((token) => token.toLowerCase());
  return change.commits.some((commit) =>
    tokens.some((token) => commit.toLowerCase().startsWith(token)),
  );
}

/** A review task that finished with a result before the landing; only these can back a verdict. */
function isFinishedReview(task: DelegatedTask, landedAt: string): boolean {
  return (
    task.role === "review" &&
    task.completedAt !== null &&
    task.completedAt <= landedAt &&
    task.result !== null &&
    task.result.trim() !== ""
  );
}

export interface ReviewScope {
  readonly change: ChangeScope;
  /** Every change in the same landing, this one included. */
  readonly landing: ReadonlyArray<ChangeScope>;
  readonly targetBranch: string;
}

/**
 * Whether a brief is about this change alone: it names the change's branch or a commit, and no
 * other change of the same landing. A brief covering two of them backs neither.
 */
function namesOnlyChange(prompt: string, scope: ReviewScope): boolean {
  if (!namesChange(prompt, scope.change, scope.targetBranch)) return false;
  return !scope.landing.some(
    (other) => other !== scope.change && namesChange(prompt, other, scope.targetBranch),
  );
}

const byStart = (left: DelegatedTask, right: DelegatedTask) =>
  left.startedAt.localeCompare(right.startedAt);

/**
 * The lead's finished review task for a change: the latest whose own brief names this change and
 * no other in the landing, so a re-check supersedes the first round. No such brief links nothing.
 */
export function matchReviewTask(
  input: ReviewScope & {
    readonly landedAt: string;
    readonly tasks: ReadonlyArray<DelegatedTask>;
  },
): DelegatedTask | null {
  return (
    input.tasks
      .filter((task) => isFinishedReview(task, input.landedAt))
      .filter((task) => namesOnlyChange(task.prompt, input))
      .toSorted(byStart)
      .at(-1) ?? null
  );
}

/**
 * The task an agent-named reviewer thread backs this change with: the one finished review task
 * whose brief names this change alone, or the thread's only finished review task when its brief
 * names no change, no known branch and no commit. Any doubt links nothing.
 */
export function selectThreadReview(
  input: ReviewScope & {
    readonly landedAt: string;
    readonly threadTasks: ReadonlyArray<DelegatedTask>;
    /** Branches the server knows of besides the landing's changes, such as delegated children's. */
    readonly knownBranches: ReadonlyArray<string>;
  },
): DelegatedTask | null {
  const finished = input.threadTasks.filter((task) => isFinishedReview(task, input.landedAt));
  const named = finished.filter((task) => namesOnlyChange(task.prompt, input));
  if (named.length === 1) return named[0]!;
  if (named.length > 1 || finished.length !== 1) return null;
  const only = finished[0]!;
  const namesSomething =
    only.prompt.match(HEX_TOKEN) !== null ||
    input.landing.some((change) => namesChange(only.prompt, change, input.targetBranch)) ||
    input.knownBranches.some(
      (branch) => branch !== input.targetBranch && namesRef(only.prompt, branch),
    );
  return namesSomething ? null : only;
}
