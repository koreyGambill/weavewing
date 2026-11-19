import type { EnvironmentId, ReviewDiffPreviewInput, VcsStatusResult } from "@t3tools/contracts";
import { revisionedQuery } from "./revisionedQuery";
import { reviewEnvironment } from "./review";

/** All readers of a Git preview use one revision so a status or workspace update refreshes it once. */
export function gitDiffPreviewQuery(
  environmentId: EnvironmentId,
  input: ReviewDiffPreviewInput,
  workspaceMutationId: string | null | undefined,
  status: VcsStatusResult | null,
) {
  // Edits, pulls and resets outside a turn can change Git status without a workspace mutation.
  const revision =
    input.sourceKind === "branch-range" && workspaceMutationId !== undefined && status
      ? JSON.stringify([
          workspaceMutationId,
          status.refName,
          status.workingTree.insertions,
          status.workingTree.deletions,
          status.branchChanges?.baseRef,
          status.branchChanges?.insertions,
          status.branchChanges?.deletions,
        ])
      : workspaceMutationId;
  return revisionedQuery(reviewEnvironment.diffPreview({ environmentId, input }), revision);
}
