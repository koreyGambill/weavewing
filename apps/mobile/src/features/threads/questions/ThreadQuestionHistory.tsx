import { sectionThreadQuestions } from "@t3tools/client-runtime/state/thread-questions";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import {
  useThreadQuestionsWorkspace,
  type QuestionThreadRef,
} from "../../../state/thread-questions";
import { ThreadQuestionCard } from "./ThreadQuestionCard";

/**
 * The thread's closed questions, newest first, each one line with its outcome and Reopen, for
 * the History part of the waiting sheet. Renders nothing until one has closed.
 */
export function ThreadQuestionHistory(props: {
  readonly threadRef: QuestionThreadRef;
  readonly workspaceRoot: string | null;
}) {
  const { workspace } = useThreadQuestionsWorkspace(props.threadRef);
  const closed = workspace == null ? [] : sectionThreadQuestions(workspace.questions).closed;
  if (closed.length === 0) return null;
  return (
    <View className="gap-2">
      <Text className="px-1 font-t3-bold text-xs text-foreground-muted">Questions</Text>
      {closed.map((question) => (
        <ThreadQuestionCard
          key={question.id}
          threadRef={props.threadRef}
          questionId={question.id}
          workspaceRoot={props.workspaceRoot}
        />
      ))}
    </View>
  );
}
