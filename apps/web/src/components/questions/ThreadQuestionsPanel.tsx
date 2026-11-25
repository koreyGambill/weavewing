import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  sectionThreadQuestions,
  threadQuestionHasDraft,
  THREAD_QUESTION_SECTIONS,
  type ThreadQuestionSection,
} from "@t3tools/client-runtime/state/thread-questions";
import { threadQuestionTitle, type ScopedThreadRef } from "@t3tools/contracts";
import { SendIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { isEditableFocused } from "~/lib/editableFocus";
import {
  threadQuestionSubmit,
  threadQuestionUpdate,
  useSaveQuestionDraft,
  useThreadQuestionsWorkspace,
} from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { ThreadQuestionCard } from "./ThreadQuestionCard";
import { questionDraftWriter } from "./questionDraftWriter";
import {
  QUESTION_PANEL_KEY_SHORTCUTS,
  questionPanelKeyAction,
  questionPanelOrder,
  resolveSelectedQuestionId,
} from "./ThreadQuestionsPanel.logic";
import { requestQuestionReveal } from "./questionReveal";
import { serverEnvironment } from "../../state/server";
import { selectThreadTileLayout, useRightPanelStore } from "../../rightPanelStore";
import { CONVERSATION_TAB_ID, getTileGroups } from "../../threadTileLayout";

const SECTION_LABELS: Record<ThreadQuestionSection, string> = {
  waiting: "Waiting",
  deferred: "Deferred",
  closed: "Closed",
};

/** The panel while the environment's agent questions setting is on; nothing otherwise. */
export function GatedThreadQuestionsPanel(props: Parameters<typeof ThreadQuestionsPanel>[0]) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.threadRef.environmentId));
  return settings?.agentQuestionsEnabled === true ? <ThreadQuestionsPanel {...props} /> : null;
}

/**
 * Every question of a thread beside the chat: a sectioned list, the selected question's card,
 * and one stationary button that sends every drafted answer in a single message.
 */
export function ThreadQuestionsPanel({
  threadRef,
  active,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  /** Its tab is the one shown, so the panel takes keyboard focus. */
  readonly active: boolean;
  readonly onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves keyboard focus into the panel as its tab is shown, so its keys never reach a hidden composer
  useEffect(() => {
    const root = rootRef.current;
    if (active && root && !root.contains(document.activeElement))
      root.focus({ preventScroll: true });
  }, [active]);
  const { workspace, error } = useThreadQuestionsWorkspace(threadRef, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const canAct = useAtomValue(threadQuestionSubmit.permissionAtom(threadRef.environmentId));
  const submit = useAtomCommand(threadQuestionSubmit);
  const saveDraft = useSaveQuestionDraft(threadRef);
  const writer = questionDraftWriter(scopedThreadKey(threadRef));
  const update = useAtomCommand(threadQuestionUpdate);
  const questions = workspace?.questions ?? [];
  const order = questionPanelOrder(questions);
  const sections = sectionThreadQuestions(questions);
  const shownId = resolveSelectedQuestionId(order, selectedId);
  const shown = order.find((question) => question.id === shownId) ?? null;
  const drafted = questions.filter(threadQuestionHasDraft);

  const send = async () => {
    setSending(true);
    // Notes still waiting or in flight are part of what the user means to send.
    const saved = await writer.flushAll(saveDraft);
    const latest =
      saved !== null && saved.revision > (workspace?.revision ?? -1) ? saved : workspace;
    const ids = (latest?.questions ?? []).filter(threadQuestionHasDraft).map((entry) => entry.id);
    const result =
      ids.length === 0
        ? null
        : await submit({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, ids },
          });
    setSending(false);
    if (result?._tag === "Success")
      toastManager.add({
        type: "success",
        title: `Sent ${ids.length} ${ids.length === 1 ? "answer" : "answers"}`,
      });
  };
  const showInChat = (id: string) => {
    const store = useRightPanelStore.getState();
    const chat = getTileGroups(selectThreadTileLayout(store.byThreadKey, threadRef)).find((group) =>
      group.tabs.includes(CONVERSATION_TAB_ID),
    );
    if (chat && chat.activeTabId !== CONVERSATION_TAB_ID)
      store.applyTileAction(threadRef, {
        type: "activate",
        groupId: chat.id,
        tabId: CONVERSATION_TAB_ID,
      });
    // A frame later, so a chat tab that was hidden has laid out before its list scrolls.
    requestAnimationFrame(() => {
      if (requestQuestionReveal(scopedThreadKey(threadRef), id) === "missing")
        toastManager.add({
          type: "info",
          title: `${id} is not in the loaded part of the chat`,
          description: "Scroll up to load earlier messages, then try again.",
        });
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== "Escape" && isEditableFocused(event.target)) return;
    const action = questionPanelKeyAction({ key: event.key, order, selectedId: shownId });
    if (action === null) return;
    event.preventDefault();
    switch (action.type) {
      case "close":
        onClose();
        return;
      case "select":
        setSelectedId(action.id);
        rootRef.current
          ?.querySelector(`[data-question-item="${CSS.escape(action.id)}"]`)
          ?.scrollIntoView({ block: "nearest" });
        return;
      case "choose": {
        const question = order.find((entry) => entry.id === action.id);
        void writer.edit(
          action.id,
          {
            chosenOptionIds: question?.answer?.chosenOptionIds ?? [],
            notes: question?.answer?.notes ?? "",
          },
          { chosenOptionIds: action.chosenOptionIds },
          saveDraft,
        );
        return;
      }
      case "defer":
        void update({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, id: action.id, state: "deferred" },
        });
        return;
    }
  };

  return (
    <div
      ref={rootRef}
      className="@container flex h-full min-h-0 flex-col outline-none"
      tabIndex={-1}
      aria-label="Question review"
      aria-keyshortcuts={QUESTION_PANEL_KEY_SHORTCUTS}
      onKeyDown={onKeyDown}
    >
      {workspace == null ? (
        <p role="status" className="flex-1 p-4 text-sm text-muted-foreground">
          {error ?? "Loading questions…"}
        </p>
      ) : questions.length === 0 ? (
        <p className="flex-1 p-4 text-sm text-muted-foreground">
          No questions yet. When an agent asks one, it shows here and in the chat.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col @min-[560px]:flex-row">
          <nav
            aria-label="Questions"
            className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border p-2 @min-[560px]:max-h-none @min-[560px]:w-64 @min-[560px]:border-r @min-[560px]:border-b-0"
          >
            {THREAD_QUESTION_SECTIONS.map((section) =>
              sections[section].length === 0 ? null : (
                <section key={section} className="mb-2">
                  <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {SECTION_LABELS[section]}
                  </h3>
                  <ul>
                    {sections[section].map((question) => (
                      <li key={question.id}>
                        <button
                          type="button"
                          data-question-item={question.id}
                          aria-current={question.id === shownId ? "true" : undefined}
                          onClick={() => setSelectedId(question.id)}
                          className={cn(
                            "flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                            question.id === shownId && "bg-accent",
                            section === "closed" && "text-muted-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "shrink-0 font-semibold tabular-nums",
                              section === "waiting" && "text-primary",
                            )}
                          >
                            {question.id}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {threadQuestionTitle(question.prompt)}
                          </span>
                          {threadQuestionHasDraft(question) ? (
                            <span className="shrink-0 text-xs text-success-foreground">
                              drafted
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
            )}
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
            {shown ? (
              <ThreadQuestionCard
                key={shown.id}
                question={shown}
                threadRef={threadRef}
                actions={
                  <Button size="xs" variant="ghost" onClick={() => showInChat(shown.id)}>
                    Show in chat
                  </Button>
                }
              />
            ) : null}
          </div>
        </div>
      )}
      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border p-3 pe-9">
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> move · <Kbd>1</Kbd>–<Kbd>9</Kbd> choose · <Kbd>N</Kbd> not yet
        </p>
        <Button
          size="sm"
          disabled={!canAct || drafted.length === 0 || sending}
          onClick={() => void send()}
        >
          <SendIcon />
          {drafted.length === 1 ? "Send 1 answer" : `Send ${drafted.length} answers`}
        </Button>
      </footer>
    </div>
  );
}
