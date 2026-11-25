import type { ReactNode } from "react";

/**
 * A question's note and its buttons in one box, like the chat composer. They share a line while
 * the note is short; once the note needs the width, the buttons wrap below it, to the right.
 * A hidden copy of the note gives the field its natural width, which a textarea cannot report,
 * so the note's own length decides the wrap and nothing else moves.
 */
export function QuestionNoteBox({
  text,
  note,
  actions,
}: {
  /** The note's text, or its placeholder while empty. */
  readonly text: string;
  readonly note: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-1 rounded-lg border border-input bg-background p-1 has-focus-visible:border-ring">
      <div className="grid min-w-40 flex-[1_1_auto]">
        <span
          aria-hidden
          className="invisible col-start-1 row-start-1 px-2.5 py-1 whitespace-pre-wrap wrap-anywhere"
        >
          {text}{" "}
        </span>
        <div className="col-start-1 row-start-1 flex min-w-0">{note}</div>
      </div>
      <span className="ms-auto flex shrink-0 items-center gap-1">{actions}</span>
    </div>
  );
}
