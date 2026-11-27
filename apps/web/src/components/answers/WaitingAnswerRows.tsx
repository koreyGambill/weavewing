import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TrackedAnswerWaitingRow } from "@t3tools/contracts";
import { useState } from "react";

import { CardStatusBadge } from "../questions/QuestionStatusBadge";
import { revealAnswerInChat, revealTrackedMessageInChat } from "../questions/questionReveal";
import { Button } from "../ui/button";
import { WaitingAnswerIcon } from "../waiting/waitingKindIcon";
import { useTrackedAsks, useUpdateTrackedAsk } from "./trackedAnswers-web-state";

export function WaitingAnswerRows({
  threadRef,
  rows,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly rows: ReadonlyArray<TrackedAnswerWaitingRow>;
}) {
  const asks = useTrackedAsks(threadRef);
  const { canUpdate, submit } = useUpdateTrackedAsk(threadRef);
  const [pending, setPending] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const open = (row: TrackedAnswerWaitingRow) => {
    const ask = asks.find((entry) => entry.id === row.ref);
    if (!ask) return;
    const key = scopedThreadKey(threadRef);
    const latest = ask.answers.at(-1);
    if (row.state === "answered" && latest) revealAnswerInChat(key, ask.id, latest.n);
    else revealTrackedMessageInChat(key, ask.askedInMessageId);
  };
  const close = async (id: string) => {
    setPending(id);
    await submit({ threadId: threadRef.threadId, id, action: "close" });
    setPending(null);
  };
  return (
    <section aria-label="Answers" className="min-w-0 space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">Answers</h3>
      <ul className="min-w-0 space-y-0.5">
        {rows.map((row) => (
          <li key={row.ref} className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1 [&>button]:max-w-full">
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!asks.some((ask) => ask.id === row.ref)}
                onClick={() => open(row)}
                title={row.title}
              >
                <WaitingAnswerIcon aria-hidden="true" />
                <strong>{row.ref}</strong>
                <span className="min-w-0 truncate text-left">{row.title}</span>
              </Button>
            </div>
            <div className="hidden shrink-0 @min-[37.5rem]:block">
              <CardStatusBadge
                variant="outline"
                help={
                  row.state === "answered"
                    ? "The answer is ready to read."
                    : "The agent owes an answer."
                }
                label={{ answered: "Answered", owed: "Owed", queued: "Queued" }[row.state]}
              />
            </div>
            {row.state === "answered" ? (
              <Button
                size="xs"
                disabled={!canUpdate || pending !== null}
                aria-label={`Got it ${row.ref}`}
                onClick={() => void close(row.ref)}
              >
                Got it
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
