import {
  EVIDENCE_THREAD_LANDING_LIMIT,
  type EvidenceChangeQa,
  type EvidenceLanding,
  type EvidenceVerification,
  type WaitingItemContextRecord,
} from "@t3tools/contracts";
import {
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind, hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";

export type QaChange = EvidenceLanding["changes"][number];

export type QaCardStatus =
  | "open"
  | "quiet"
  | "in-composer"
  | "discussing"
  | "confirmed"
  | "recorded"
  | "agent-fixing"
  | "dismissed";

export const QA_STATUS_LABEL: Record<QaCardStatus, string> = {
  open: "Open",
  quiet: "Nothing to check",
  "in-composer": "In composer",
  discussing: "Discussing",
  confirmed: "Confirmed by you",
  recorded: "Recorded by the agent",
  "agent-fixing": "Agent fixing",
  dismissed: "Dismissed",
};

/**
 * Whether a change shows a card. A quiet change had nothing to judge, and a landing from before
 * reasons were kept shows one only while it still waits on the user.
 */
export function qaShowsCard(qa: EvidenceChangeQa): boolean {
  if (qa.state === "quiet") return false;
  return qa.raised !== undefined || qa.state === "pending";
}

export function qaCardStatus(qa: EvidenceChangeQa, inComposer: boolean): QaCardStatus {
  switch (qa.state) {
    case "pending":
    case "quiet":
      if (inComposer) return "in-composer";
      if (qa.discussedMessageId !== undefined) return "discussing";
      // Recorded quietly: only Evidence lists it, and the user may still answer it.
      return qa.state === "quiet" ? "quiet" : "open";
    case "problem":
      return "agent-fixing";
    case "confirmed":
      return qa.by === "agent" ? "recorded" : "confirmed";
    case "waived":
      return qa.by === "agent" ? "recorded" : "dismissed";
  }
}

/** The user can still answer: the change waits on them. */
export const qaWaiting = (qa: EvidenceChangeQa) => qa.state === "pending" || qa.state === "quiet";

const firstLine = (text: string) => text.split("\n", 1)[0]!.trim();

/** The card's title: the change's summary, else the user's ask, else its id. */
export function qaCardTitle(change: Pick<QaChange, "summary" | "ask" | "id">): string {
  return firstLine(change.summary) || firstLine(change.ask) || change.id;
}

export const qaRef = (change: QaChange) =>
  change.qa.ref === undefined ? "QA" : `QA${change.qa.ref}`;

/** "Landed on main · abc1234", plus the ask when the title is not already the ask. */
export function qaLandedLine(landing: Pick<EvidenceLanding, "target">, change: QaChange): string {
  const ask = firstLine(change.ask);
  return [
    `Landed on ${landing.target.branch}`,
    landing.target.sha.slice(0, 7),
    ...(ask && ask !== qaCardTitle(change) ? [`from “${ask}”`] : []),
  ].join(" · ");
}

const REVIEW_CLAIM = { approved: "approved", changes_requested: "changes requested" } as const;

/** Nothing checks a reviewer's verdict yet, so every claim reads as the agent's word. */
export function qaReviewLabel(review: QaChange["review"]): string {
  if (review.verdict === "waived")
    return review.reason ? `Review waived: ${review.reason}` : "Review waived";
  return `Unverified · agent reported ${REVIEW_CLAIM[review.verdict]}${review.by ? ` by ${review.by}` : ""}`;
}

/** One line per check, with the reason a skipped one gives. */
export function qaCheckLabel(check: Pick<EvidenceVerification, "label" | "result" | "reason">) {
  const base =
    check.result === "pass"
      ? check.label
      : `${check.label} ${check.result === "fail" ? "failed" : "skipped"}`;
  return check.result === "skipped" && check.reason ? `${base}: ${check.reason}` : base;
}

/** What the note under the card is: the agent's, the problem, or the user's reason. */
export function qaNoteLabel(qa: EvidenceChangeQa): string | null {
  if (qa.note.trim() === "") return null;
  if (qa.state === "problem") return "Problem";
  return qa.by === "agent" ? "Agent's note" : "Reason";
}

/** The landing and change a waiting QA row's key names, from the thread's landings. */
export function findQaChange(
  landings: ReadonlyArray<EvidenceLanding>,
  parts: { readonly landingId: string; readonly changeId: string },
): { readonly landing: EvidenceLanding; readonly change: QaChange } | null {
  const landing = landings.find((entry) => entry.id === parts.landingId);
  const change = landing?.changes.find((entry) => entry.id === parts.changeId);
  return landing === undefined || change === undefined ? null : { landing, change };
}

/**
 * Whether the read hit the server's cap on a thread's newest landings, so older answered QA may
 * exist beyond History. A thread with exactly the cap reads as capped too.
 */
export const qaHistoryCapped = (landings: ReadonlyArray<EvidenceLanding>) =>
  landings.length >= EVIDENCE_THREAD_LANDING_LIMIT;

/** A settled or agent-owned change from the thread's landings, for the History list. */
export interface QaHistoryEntry {
  readonly key: string;
  readonly landing: EvidenceLanding;
  readonly change: QaChange;
}

/**
 * The thread's answered QA, newest first: confirmed, dismissed, and problems the agent owes.
 * Changes the waiting rows already list are left out, and so are those still waiting past the cap.
 */
export function qaHistory(
  landings: ReadonlyArray<EvidenceLanding>,
  listedKeys: ReadonlySet<string>,
): ReadonlyArray<QaHistoryEntry> {
  return landings
    .flatMap((landing) =>
      landing.changes.flatMap((change) => {
        const key = `${landing.id}/${change.id}`;
        return listedKeys.has(key) || !qaShowsCard(change.qa) || qaWaiting(change.qa)
          ? []
          : [{ key, landing, change }];
      }),
    )
    .sort(
      (a, b) =>
        b.change.qa.updatedAt.localeCompare(a.change.qa.updatedAt) || a.key.localeCompare(b.key),
    );
}

/**
 * How a capture opens: the image, video, PDF or document viewer, or not at all when the server
 * serves no inline preview for its file type.
 */
export function qaCapturePreview(path: string): {
  readonly kind: "image" | "video" | "pdf" | "document" | "unavailable";
  readonly name: string;
  readonly mimeType: string;
} {
  const name = path.slice(path.lastIndexOf("/") + 1) || path;
  const dot = name.lastIndexOf(".");
  // The server's own rule for inline media files, so a capture it refuses never opens a viewer.
  const mimeType = dot < 0 ? null : hostPreviewMimeTypeFromExtension(name.slice(dot));
  if (mimeType === null) return { kind: "unavailable", name, mimeType: "application/octet-stream" };
  const kind = filePreviewKind({ name, mimeType });
  return {
    kind: kind === "image" || kind === "video" || kind === "pdf" ? kind : "document",
    name,
    mimeType,
  };
}

/** The composer reference Discuss adds for one change, labelled `QA3 · discuss · <title>`. */
export function qaDiscussRecord(
  landing: Pick<EvidenceLanding, "id" | "target">,
  change: QaChange,
): WaitingItemContextRecord {
  const key = `${landing.id}/${change.id}`;
  const ref = qaRef(change);
  const title = qaCardTitle(change);
  return {
    version: 1,
    kind: "waiting-item",
    contextId: toKindScopedComposerContextId("waiting-item", key),
    label: sanitizeComposerContextLabel(`${ref} · discuss · ${title}`, "waiting-item"),
    itemKind: "qa",
    key,
    ref,
    title: title.slice(0, 2048),
    sha: landing.target.sha,
  };
}
