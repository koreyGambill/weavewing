import { useAtomValue } from "@effect/atom-react";
import {
  threadQuestionAnswerRecord,
  threadQuestionDiscussRecord,
  threadQuestionStatus,
  type ThreadQuestionStatus,
} from "@t3tools/client-runtime/state/thread-questions";
import type { ThreadQuestion } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Notice } from "../../../components/ui/Notice";
import { cn } from "../../../lib/cn";
import {
  threadQuestionDraft,
  threadQuestionUpdate,
  useThreadQuestionsWorkspace,
  type QuestionThreadRef,
} from "../../../state/thread-questions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { QuestionText } from "../PendingUserInputCard";
import {
  QUESTION_STATUS_LABELS,
  closedQuestionOutcome,
  questionAfterSave,
  toggleQuestionOption,
  type QuestionDraft,
} from "./questionCard.logic";
import {
  addQuestionRecordToComposer,
  removeQuestionRecordFromComposer,
  useQuestionsInComposer,
} from "./questionComposer";
import { holdQuestionDraft, questionDraft } from "./questionDrafts";

const NOTE_SAVE_DELAY_MS = 600;

export interface ThreadQuestionCardProps {
  readonly threadRef: QuestionThreadRef;
  readonly questionId: string;
  /** Resolves relative file links in the question's details. */
  readonly workspaceRoot?: string | null;
  /** Runs once Answer or Discuss put a chip in the composer, such as to close a sheet. */
  readonly onAddedToComposer?: () => void;
}

/**
 * One agent question, read from the thread's workspace. Open and deferred questions show their
 * options, a note and their actions; a closed one shows its outcome in one line, which expands
 * to the full prompt. Renders nothing while the question is not loaded or agent questions are off.
 */
export function ThreadQuestionCard(props: ThreadQuestionCardProps) {
  const { workspace } = useThreadQuestionsWorkspace(props.threadRef);
  const question = workspace?.questions.find((entry) => entry.id === props.questionId);
  if (workspace == null || question === undefined) return null;
  return (
    <QuestionCard
      threadRef={props.threadRef}
      workspaceRoot={props.workspaceRoot ?? null}
      onAddedToComposer={props.onAddedToComposer}
      question={question}
      revision={workspace.revision}
    />
  );
}

const STATUS_TONES: Record<ThreadQuestionStatus, { pill: string; text: string }> = {
  open: { pill: "bg-subtle", text: "text-foreground-secondary" },
  deferred: { pill: "bg-subtle", text: "text-foreground-muted" },
  drafted: { pill: "bg-subtle", text: "text-foreground-secondary" },
  "in-composer": {
    pill: "bg-adaptive-sky-500-a12-a16",
    text: "text-adaptive-sky-700-300",
  },
  "comment-in-composer": {
    pill: "bg-adaptive-sky-500-a12-a16",
    text: "text-adaptive-sky-700-300",
  },
  sent: { pill: "bg-adaptive-amber-500-a12-a16", text: "text-adaptive-amber-700-300" },
  discussing: { pill: "bg-adaptive-sky-500-a12-a16", text: "text-adaptive-sky-700-300" },
  received: {
    pill: "bg-adaptive-emerald-500-a12-a16",
    text: "text-adaptive-emerald-700-300",
  },
  recorded: {
    pill: "bg-adaptive-emerald-500-a12-a16",
    text: "text-adaptive-emerald-700-300",
  },
  dismissed: { pill: "bg-subtle", text: "text-foreground-muted" },
  replaced: { pill: "bg-subtle", text: "text-foreground-muted" },
};

function StatusBadge({ status }: { readonly status: ThreadQuestionStatus }) {
  const tone = STATUS_TONES[status];
  return (
    <View className={cn("shrink-0 rounded-full px-2.5 py-1", tone.pill)}>
      <Text className={cn("font-t3-bold text-2xs", tone.text)}>
        {QUESTION_STATUS_LABELS[status]}
      </Text>
    </View>
  );
}

function OptionRow(props: {
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly selected: boolean;
  readonly multiSelect: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={props.multiSelect ? "checkbox" : "radio"}
      accessibilityLabel={[
        props.label,
        props.recommended ? "recommended" : null,
        props.description || null,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-12 w-full flex-row items-start gap-3 rounded-2xl border px-3.5 py-3 active:opacity-70",
        props.selected ? "border-primary bg-primary/10" : "border-border bg-input",
      )}
    >
      <View
        className={cn(
          "mt-0.5 h-5 w-5 items-center justify-center border",
          props.multiSelect ? "rounded-md" : "rounded-full",
          props.selected ? "border-primary bg-primary" : "border-border",
        )}
      >
        {props.selected ? (
          <SymbolView name="checkmark" size={12} tintColorClassName="accent-primary-foreground" />
        ) : null}
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text
            className={cn(
              "font-t3-bold text-sm",
              props.selected ? "text-foreground" : "text-foreground-secondary",
            )}
          >
            {props.label}
          </Text>
          {props.recommended ? (
            <View className="rounded-full bg-adaptive-sky-500-a12-a16 px-2 py-0.5">
              <Text className="font-t3-bold text-2xs text-adaptive-sky-700-300">Recommended</Text>
            </View>
          ) : null}
        </View>
        {props.description ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {props.description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function QuestionCard(props: {
  readonly threadRef: QuestionThreadRef;
  readonly workspaceRoot: string | null;
  readonly question: ThreadQuestion;
  readonly revision: number;
  readonly onAddedToComposer: (() => void) | undefined;
}) {
  const { threadRef, question } = props;
  const canAct = useAtomValue(threadQuestionDraft.permissionAtom(threadRef.environmentId));
  const update = useAtomCommand(threadQuestionUpdate, { reportFailure: false });
  const inComposer = useQuestionsInComposer(threadRef).get(question.id);
  const draft = questionDraft(threadRef, question.id);
  const { environmentId, threadId } = threadRef;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- counts this card in the draft saver registry until unmount, so the registry drops the question's saver once unheld and idle
  useEffect(
    () => holdQuestionDraft({ environmentId, threadId }, question.id),
    [environmentId, threadId, question.id],
  );
  // Local until the server returns them, so typing and choosing never wait on a round trip.
  const [pendingChoice, setPendingChoice] = useState<ReadonlyArray<string> | null>(null);
  const [pendingNotes, setPendingNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // The shared saver still holds edits an earlier mount made, or a failed write keeps for retry.
  const unsaved = draft.pending();
  const chosenOptionIds =
    pendingChoice ?? unsaved?.chosenOptionIds ?? question.answer?.chosenOptionIds ?? [];
  const notes = pendingNotes ?? unsaved?.notes ?? question.answer?.notes ?? "";
  const status = threadQuestionStatus(question, inComposer);
  const waiting = question.state === "open" || question.state === "deferred";
  const editable = waiting && status !== "sent";
  const usable = canAct && !busy && editable;
  const hasDraft = chosenOptionIds.length > 0 || notes.trim() !== "";
  const outcome = closedQuestionOutcome(question);
  const draftError = `${question.id}'s draft did not save. Try again once the connection is back.`;

  const edit = (change: Partial<QuestionDraft>, delayMs?: number) =>
    void draft
      .edit(
        {
          chosenOptionIds: question.answer?.chosenOptionIds ?? [],
          notes: question.answer?.notes ?? "",
        },
        change,
        delayMs,
      )
      .then((saved) => {
        if (!saved) setError(draftError);
        // A later edit keeps its own pending value; this write only clears what it carried, and
        // a failed one stays readable from the saver.
        setPendingChoice((current) => (current === change.chosenOptionIds ? null : current));
        setPendingNotes((current) => (current === change.notes ? null : current));
      });
  const flush = async () => {
    const flushed = await draft.flush();
    if (flushed === null) setError(draftError);
    return flushed;
  };
  const changeState = async (state: "open" | "deferred" | "withdrawn") => {
    setBusy(true);
    setError(null);
    await flush();
    const result = await update({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, id: question.id, state },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(result))
      setError(`${question.id} did not change. Try again once the connection is back.`);
  };
  const toComposer = async (kind: "answer" | "discuss") => {
    setBusy(true);
    setError(null);
    // Notes still waiting or in flight are part of what the user means to queue.
    const latest = questionAfterSave(question, props.revision, await flush());
    setBusy(false);
    if (latest === null) return;
    const record =
      kind === "answer"
        ? threadQuestionAnswerRecord(threadRef.threadId, latest)
        : threadQuestionDiscussRecord(threadRef.threadId, latest);
    if (record === null) return;
    addQuestionRecordToComposer(threadRef, record);
    props.onAddedToComposer?.();
  };

  const reopenable = question.state === "answered" || question.state === "withdrawn";
  const errorNotice =
    error === null ? null : (
      <Notice
        tone="danger"
        message={error}
        dismissLabel="Dismiss error"
        onDismiss={() => setError(null)}
      />
    );

  if (outcome !== null) {
    return (
      <View className="gap-2 rounded-2xl border border-border bg-card-alt px-3.5 py-2.5">
        <View className="flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${question.id}: ${question.prompt}. ${outcome}`}
            accessibilityHint={expanded ? "Shows one line" : "Shows the whole question"}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((current) => !current)}
            className="min-h-11 min-w-0 flex-1 justify-center gap-0.5 active:opacity-70"
          >
            <Text
              numberOfLines={expanded ? undefined : 1}
              className="font-t3-medium text-sm text-foreground-secondary"
            >
              <Text className="font-t3-bold text-foreground-muted">{question.id} </Text>
              {question.prompt}
            </Text>
            {outcome ? (
              <Text
                numberOfLines={expanded ? undefined : 1}
                className="font-sans text-xs text-foreground-muted"
              >
                {outcome}
              </Text>
            ) : null}
          </Pressable>
          {question.state === "answered" ? <StatusBadge status={status} /> : null}
          {reopenable ? (
            <Button
              label="Reopen"
              accessibilityLabel={`Reopen ${question.id}`}
              disabled={!canAct || busy}
              onPress={() => {
                setExpanded(false);
                void changeState("open");
              }}
            />
          ) : null}
        </View>
        {errorNotice}
      </View>
    );
  }

  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-start gap-2">
        <Text selectable className="min-w-0 flex-1 font-t3-bold text-base text-foreground">
          <Text className="text-foreground-muted">{question.id} </Text>
          {question.prompt}
        </Text>
        <StatusBadge status={status} />
      </View>
      {question.details ? (
        <QuestionText
          markdown={question.details}
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          workspaceRoot={props.workspaceRoot}
          setDirection={undefined}
          preserveSoftBreaks
        />
      ) : null}
      {question.options.length > 0 ? (
        <View accessibilityRole={question.multiSelect ? undefined : "radiogroup"} className="gap-2">
          {question.multiSelect ? (
            <Text className="font-sans text-xs text-foreground-muted">Choose any that apply</Text>
          ) : null}
          {question.options.map((option) => (
            <OptionRow
              key={option.id}
              label={option.label}
              description={option.description}
              recommended={question.recommendedOptionIds.includes(option.id)}
              selected={chosenOptionIds.includes(option.id)}
              multiSelect={question.multiSelect}
              disabled={!usable}
              onPress={() => {
                const next = toggleQuestionOption(question, chosenOptionIds, option.id);
                setPendingChoice(next);
                edit({ chosenOptionIds: next });
              }}
            />
          ))}
        </View>
      ) : null}
      <TextInput
        accessibilityLabel={`Note for ${question.id}`}
        placeholder={question.options.length > 0 ? "Add a note…" : "Your answer…"}
        value={notes}
        editable={canAct && editable}
        multiline
        className="min-h-12 rounded-2xl border border-border bg-input px-3.5 py-3 font-sans text-sm text-foreground"
        onChangeText={(next) => {
          setPendingNotes(next);
          edit({ notes: next }, NOTE_SAVE_DELAY_MS);
        }}
        onBlur={() => void flush()}
      />
      <View className="flex-row flex-wrap items-center gap-2">
        {question.state === "deferred" ? (
          <Button
            label="Reopen"
            accessibilityLabel={`Reopen ${question.id}`}
            disabled={!usable}
            onPress={() => void changeState("open")}
          />
        ) : (
          <Button
            label="Defer"
            accessibilityLabel={`Defer ${question.id}`}
            accessibilityHint="Sets it aside; the agent may raise it again"
            disabled={!usable}
            onPress={() => void changeState("deferred")}
          />
        )}
        <Button
          label="Dismiss"
          accessibilityLabel={`Dismiss ${question.id}`}
          accessibilityHint="Closes it without answering; the agent is told with your next message"
          disabled={!usable}
          onPress={() => void changeState("withdrawn")}
        />
        <Button
          label={inComposer === "discuss" ? "Cancel comment" : "Discuss"}
          accessibilityLabel={
            inComposer === "discuss"
              ? `Take the comment on ${question.id} out of the composer`
              : `Discuss ${question.id}`
          }
          accessibilityHint={
            inComposer === "discuss" ? undefined : "Puts your note in the composer as a comment"
          }
          disabled={!usable || (inComposer !== "discuss" && notes.trim() === "")}
          onPress={() =>
            inComposer === "discuss"
              ? removeQuestionRecordFromComposer(threadRef, question.id)
              : void toComposer("discuss")
          }
        />
        <View className="flex-1" />
        <Button
          label={inComposer === "answer" ? "Cancel answer" : "Answer"}
          accessibilityLabel={
            inComposer === "answer"
              ? `Take the answer to ${question.id} out of the composer`
              : `Answer ${question.id}`
          }
          accessibilityHint={
            inComposer === "answer" ? undefined : "Adds the answer to your next message"
          }
          tone={inComposer !== "answer" && usable && hasDraft ? "primary" : "secondary"}
          disabled={!usable || (inComposer !== "answer" && !hasDraft)}
          onPress={() =>
            inComposer === "answer"
              ? removeQuestionRecordFromComposer(threadRef, question.id)
              : void toComposer("answer")
          }
        />
      </View>
      {!canAct ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          This connection cannot answer questions.
        </Text>
      ) : null}
      {errorNotice}
    </View>
  );
}
