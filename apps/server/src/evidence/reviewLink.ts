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
  readonly branch: string | null;
}

export type ThreadReviewVerdict = "approved" | "changes_requested";

const VERDICTS: ReadonlyMap<string, ThreadReviewVerdict> = new Map([
  ["approve", "approved"],
  ["approved", "approved"],
  ["lgtm", "approved"],
  ["request changes", "changes_requested"],
  ["requested changes", "changes_requested"],
  ["changes requested", "changes_requested"],
  ["changes_requested", "changes_requested"],
  ["request-changes", "changes_requested"],
]);

const VERDICT_LINE = /^verdict\s*[:–—-]\s*(.+?)\.?$/i;

/** The line's verdict value, from a plain `Verdict: x` line or one wholly in bold. */
function verdictValue(line: string): string | null {
  const trimmed = line.trim().replace(/^[-*+]\s+/, "");
  const bold = /^(\*\*|__)(.+?)\1(.*)$/.exec(trimmed);
  const candidate = bold === null ? trimmed : bold[2]!;
  const match = VERDICT_LINE.exec(candidate.trim());
  return match === null ? null : match[1]!.trim().replace(/\.$/, "").toLowerCase();
}

/**
 * The verdict a reviewer's final message states, only when it has exactly one verdict line
 * outside quotes and code blocks and that line's whole value is a known verdict. Anything else,
 * including a conditional ("approve after tests pass"), is not a confirmed verdict.
 */
export function reviewVerdictFromText(text: string): ThreadReviewVerdict | null {
  let fenced = false;
  const values: Array<string> = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*>/.test(line)) continue;
    const value = verdictValue(line);
    if (value !== null) values.push(value);
  }
  return values.length === 1 ? (VERDICTS.get(values[0]!) ?? null) : null;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` contains `name` as a whole branch name, not as part of a longer one. */
function namesBranch(text: string, name: string): boolean {
  return new RegExp(
    `(?<![A-Za-z0-9._/-])${escapeRegExp(name)}(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9_/-])`,
  ).test(text);
}

const HEX_TOKEN = /(?<![0-9a-z])[0-9a-f]{7,64}(?![0-9a-z])/gi;

function namesChange(
  prompt: string,
  change: Pick<EvidenceChange, "branch" | "commits">,
  targetBranch: string,
): boolean {
  const branch = change.branch;
  if (branch !== undefined && branch !== targetBranch && namesBranch(prompt, branch)) return true;
  const tokens = (prompt.match(HEX_TOKEN) ?? []).map((token) => token.toLowerCase());
  return change.commits.some(
    (commit) =>
      commit.length >= 7 &&
      tokens.some((token) => commit.startsWith(token) || token.startsWith(commit)),
  );
}

const byStart = (left: DelegatedTask, right: DelegatedTask) =>
  left.startedAt.localeCompare(right.startedAt);

/** A review task that finished with a result before the landing; only these can back a verdict. */
export function isFinishedReview(task: DelegatedTask, landedAt: string): boolean {
  return (
    task.role === "review" &&
    task.completedAt !== null &&
    task.completedAt <= landedAt &&
    task.result !== null &&
    task.result.trim() !== ""
  );
}

/**
 * The lead's finished review task for a change, declining whenever there is doubt: the latest whose
 * own brief names the change's branch or a commit, else the latest started after the implementing
 * child and before the next one, while no other implementation lane is still awaiting review.
 */
export function matchReviewTask(input: {
  readonly change: Pick<EvidenceChange, "branch" | "commits">;
  readonly targetBranch: string;
  readonly landedAt: string;
  /** The landing's thread when it is itself one of the lead's children. */
  readonly implementerThreadId: string | null;
  readonly tasks: ReadonlyArray<DelegatedTask>;
}): DelegatedTask | null {
  const reviews = input.tasks
    .filter((task) => isFinishedReview(task, input.landedAt))
    .toSorted(byStart);
  const named = reviews.filter((task) =>
    namesChange(task.prompt, input.change, input.targetBranch),
  );
  if (named.length > 0) return named.at(-1)!;

  // Each implementation child counts once, from its first task.
  const firstTasks = new Map<string, DelegatedTask>();
  for (const task of input.tasks.filter((task) => task.role === "implementation").toSorted(byStart))
    if (!firstTasks.has(task.childThreadId)) firstTasks.set(task.childThreadId, task);
  const lanes = [...firstTasks.values()];
  const onBranch =
    input.change.branch === undefined || input.change.branch === input.targetBranch
      ? []
      : lanes.filter((lane) => lane.branch === input.change.branch);
  const implementer =
    lanes.find((lane) => lane.childThreadId === input.implementerThreadId) ??
    (onBranch.length === 1 ? onBranch[0] : undefined);
  if (implementer === undefined) return null;
  const allReviews = input.tasks.filter((task) => task.role === "review");
  // Another lane started earlier with no review since is still open, so a review could be its.
  const otherOpenLane = lanes.some(
    (lane) =>
      lane !== implementer &&
      lane.startedAt < implementer.startedAt &&
      !allReviews.some(
        (review) => review.startedAt > lane.startedAt && review.startedAt < implementer.startedAt,
      ),
  );
  if (otherOpenLane) return null;
  const next = lanes.find((lane) => lane.startedAt > implementer.startedAt);
  return (
    reviews
      .filter(
        (task) =>
          task.startedAt > implementer.startedAt &&
          (next === undefined || task.startedAt < next.startedAt),
      )
      .at(-1) ?? null
  );
}
