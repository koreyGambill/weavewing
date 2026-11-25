import { useEffect, useEffectEvent } from "react";

import { subscribeQuestionReveal } from "./questionReveal";

/** Lets the questions panel scroll this thread's timeline to a question's card. */
export function useQuestionReveal(threadKey: string, reveal: (questionId: string) => boolean) {
  const onReveal = useEffectEvent(reveal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the open timeline to reveal requests from the questions panel
  useEffect(
    () => subscribeQuestionReveal(threadKey, (questionId) => onReveal(questionId)),
    [threadKey],
  );
}
