import { useEffect, useEffectEvent } from "react";

import { servePendingQuestionReveal, subscribeQuestionReveal } from "./questionReveal";

/**
 * Lets the questions panel scroll this thread's timeline to a question's card. A request made
 * before the timeline mounted or loaded its rows is served once `rowCount` changes.
 */
export function useQuestionReveal(
  threadKey: string,
  rowCount: number,
  reveal: (questionId: string) => boolean,
) {
  const onReveal = useEffectEvent(reveal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the open timeline to reveal requests from the questions panel
  useEffect(
    () => subscribeQuestionReveal(threadKey, (questionId) => onReveal(questionId)),
    [threadKey],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- serves a reveal requested while this timeline was not mounted or its rows not loaded
  useEffect(() => {
    if (rowCount > 0) servePendingQuestionReveal(threadKey, (questionId) => onReveal(questionId));
  }, [threadKey, rowCount]);
}
