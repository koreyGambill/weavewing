import type { WaitingItemSummary } from "@t3tools/contracts";

import {
  useThreadQuestionsWorkspace,
  type QuestionThreadRef,
} from "../../../state/thread-questions";
import { workspaceQuestionRows } from "./questionCard.logic";

/**
 * The thread's open and deferred questions as waiting rows once its workspace has loaded, or
 * undefined until then, so a list can fall back to the thread's capped rows.
 */
export function useWorkspaceQuestionRows(
  threadRef: QuestionThreadRef,
): ReadonlyArray<WaitingItemSummary> | undefined {
  const { workspace } = useThreadQuestionsWorkspace(threadRef);
  return workspace == null ? undefined : workspaceQuestionRows(workspace.questions);
}
