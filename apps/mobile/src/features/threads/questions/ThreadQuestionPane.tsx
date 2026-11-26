import { AppText as Text } from "../../../components/ui/AppText";
import {
  useThreadQuestionsWorkspace,
  useWaitingCardsEnabled,
  type QuestionThreadRef,
} from "../../../state/thread-questions";
import { ThreadQuestionCard } from "./ThreadQuestionCard";

/**
 * One agent question's card, as opened from a waiting row, or why it has none. `onDone` runs once
 * Answer or Discuss put a chip in the composer.
 */
export function ThreadQuestionPane(props: {
  readonly threadRef: QuestionThreadRef;
  readonly questionId: string;
  readonly workspaceRoot: string | null;
  readonly onDone: () => void;
}) {
  const enabled = useWaitingCardsEnabled(props.threadRef.environmentId);
  const { workspace, error } = useThreadQuestionsWorkspace(props.threadRef);
  const found = workspace?.questions.some((question) => question.id === props.questionId);
  const note =
    enabled === false
      ? "Waiting cards are off for this environment."
      : error !== null
        ? `Could not load the question: ${error}`
        : workspace == null
          ? "Loading…"
          : found
            ? null
            : "This question is no longer in the thread.";
  if (note !== null)
    return <Text className="px-1 font-sans text-sm text-foreground-secondary">{note}</Text>;
  return (
    <ThreadQuestionCard
      threadRef={props.threadRef}
      questionId={props.questionId}
      workspaceRoot={props.workspaceRoot}
      onAddedToComposer={props.onDone}
    />
  );
}
