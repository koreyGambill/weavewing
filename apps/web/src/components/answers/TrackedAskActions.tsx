import {
  type ScopedThreadRef,
  type ThreadUpdateAskInput,
  type TrackedAsk,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup } from "../ui/popover";
import { useUpdateTrackedAsk } from "./trackedAnswers-web-state";

export function TrackedAskActions({
  ask,
  threadRef,
  onShow,
  onSaved,
}: {
  readonly ask: TrackedAsk;
  readonly threadRef: ScopedThreadRef;
  readonly onShow: () => void;
  readonly onSaved?: () => void;
}) {
  const { canUpdate, submit } = useUpdateTrackedAsk(threadRef);
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(ask.question);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canEdit = ask.state === "queued" || ask.state === "owed";
  const canWithdraw = canEdit || ask.state === "answered";
  const canRestore = ask.withdrawnBecause === "user";
  const canReopen = ask.state === "closed";
  const showAnswer = ask.state === "closed" || ask.state === "answered";
  if (ask.withdrawnBecause === "rollback") return null;
  const finishEdit = () => setEditing(false);
  const action = async (input: ThreadUpdateAskInput["action"]) => {
    const fields = { threadId: threadRef.threadId, id: ask.id };
    setBusy(true);
    const saved = await submit(
      input === "edit"
        ? { ...fields, action: input, question: question.trim() }
        : { ...fields, action: input },
    );
    setBusy(false);
    if (saved) {
      if (input === "edit") finishEdit();
      onSaved?.();
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={!canUpdate}
              aria-busy={busy}
              aria-label={`Actions for ${ask.id}`}
              ref={trigger}
            />
          }
        >
          <EllipsisIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" finalFocus={trigger}>
          {showAnswer ? <MenuItem onClick={onShow}>Show answer</MenuItem> : null}
          {canEdit ? (
            <MenuItem
              disabled={busy}
              onClick={() => {
                setQuestion(ask.question);
                setEditing(true);
              }}
            >
              Edit question
            </MenuItem>
          ) : null}
          {canWithdraw ? (
            <MenuItem disabled={busy} onClick={() => void action("withdraw")}>
              Withdraw
            </MenuItem>
          ) : null}
          {canRestore ? (
            <MenuItem disabled={busy} onClick={() => void action("restore")}>
              Restore
            </MenuItem>
          ) : null}
          {canReopen ? (
            <MenuItem disabled={busy} onClick={() => void action("reopen")}>
              Reopen
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      <Popover open={editing} onOpenChange={setEditing}>
        <PopoverPopup anchor={trigger} align="end" initialFocus={inputRef} finalFocus={trigger}>
          <form
            className="w-72 max-w-full space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (question.trim() && !busy) void action("edit");
            }}
          >
            <Input
              ref={inputRef}
              aria-label={`Edit question ${ask.id}`}
              maxLength={200}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <div className="flex justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={finishEdit}>
                Cancel
              </Button>
              <Button size="xs" type="submit" disabled={!question.trim() || busy}>
                Save
              </Button>
            </div>
          </form>
        </PopoverPopup>
      </Popover>
    </>
  );
}
