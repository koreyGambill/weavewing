import type { EvidenceChange, OrchestrationV2DelegateRole } from "@t3tools/contracts";

/** One delegated child of the lead, folded from its task records. */
export interface DelegatedChild {
  readonly threadId: string;
  readonly role: OrchestrationV2DelegateRole | null;
  /** ISO time its first task started. */
  readonly startedAt: string;
  /** The brief its parent sent. */
  readonly prompt: string;
  readonly branch: string | null;
}

export type ThreadReviewVerdict = "approved" | "changes_requested";

const VERDICT_LINE = /\bverdict\b[\s*_]*[:\-–—]+[\s*_]*([a-z][a-z -]{0,40})/gi;

/**
 * The verdict a reviewer's final message states on a `Verdict:` line, the last
 * one when it gives several. Anything else is left to the agent's own record.
 */
export function reviewVerdictFromText(text: string): ThreadReviewVerdict | null {
  const phrase = [...text.matchAll(VERDICT_LINE)].at(-1)?.[1]?.trim().toLowerCase();
  if (phrase === undefined) return null;
  if (
    /^(request(ed|ing|s)? changes|changes[ -]requested|needs? (changes|work)|rework|hold|block|reject|do not (merge|land|ship))/.test(
      phrase,
    ) ||
    /\bwith[ -](fixes|changes)\b/.test(phrase)
  )
    return "changes_requested";
  if (/^(approved?|lgtm|pass(es|ed)?|ship|safe to (merge|land|ship))\b/.test(phrase))
    return "approved";
  return null;
}

const HEX_TOKEN = /\b[0-9a-f]{7,64}\b/g;

function namesChange(
  prompt: string,
  change: Pick<EvidenceChange, "branch" | "commits">,
  targetBranch: string,
): boolean {
  const branch = change.branch;
  if (branch !== undefined && branch !== targetBranch && prompt.includes(branch)) return true;
  const tokens = prompt.toLowerCase().match(HEX_TOKEN) ?? [];
  return change.commits.some(
    (commit) =>
      commit.length >= 7 &&
      tokens.some((token) => commit.startsWith(token) || token.startsWith(commit)),
  );
}

const latest = (children: ReadonlyArray<DelegatedChild>) =>
  children.toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;

/**
 * The lead's review-role child that reviewed a change: the latest whose brief names its branch or
 * a commit, else the latest started after the implementing child and before the next one. A
 * re-check supersedes the first round; reviewers started after the landing never count.
 */
export function matchReviewThread(input: {
  readonly change: Pick<EvidenceChange, "branch" | "commits">;
  readonly targetBranch: string;
  readonly landedAt: string;
  /** The landing's thread when it is itself one of the lead's children. */
  readonly implementerThreadId: string | null;
  readonly children: ReadonlyArray<DelegatedChild>;
}): DelegatedChild | null {
  const reviewers = input.children.filter(
    (child) => child.role === "review" && child.startedAt <= input.landedAt,
  );
  const named = reviewers.filter((child) =>
    namesChange(child.prompt, input.change, input.targetBranch),
  );
  if (named.length > 0) return latest(named);

  const implementations = input.children.filter((child) => child.role === "implementation");
  const onBranch =
    input.change.branch === undefined || input.change.branch === input.targetBranch
      ? []
      : implementations.filter((child) => child.branch === input.change.branch);
  const implementer =
    input.children.find((child) => child.threadId === input.implementerThreadId) ??
    (onBranch.length === 1 ? onBranch[0] : undefined);
  if (implementer === undefined) return null;
  const nextImplementation = implementations
    .filter((child) => child.startedAt > implementer.startedAt)
    .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))[0];
  return latest(
    reviewers.filter(
      (child) =>
        child.startedAt > implementer.startedAt &&
        (nextImplementation === undefined || child.startedAt < nextImplementation.startedAt),
    ),
  );
}
