import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  sectionThreadQuestions,
  threadQuestionHasDraft,
  THREAD_QUESTION_SECTIONS,
  type ThreadQuestionSection,
} from "@t3tools/client-runtime/state/thread-questions";
import { threadQuestionTitle, type ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { isEditableFocused } from "~/lib/editableFocus";
import {
  threadQuestionDraft,
  threadQuestionUpdate,
  useSaveQuestionDraft,
  useThreadQuestionsWorkspace,
} from "../../state/threadQuestions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadQuestionCard } from "./ThreadQuestionCard";
import { addDraftedAnswersToComposer, useQuestionsInComposer } from "./questionComposer";
import { questionDraftWriter } from "./questionDraftWriter";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Toggle } from "../ui/toggle";
import {
  DEFAULT_QUESTION_FILTERS,
  filterQuestions,
  QUESTION_FILTERS,
  QUESTION_FILTERS_STORAGE_KEY,
  QUESTION_PANEL_KEY_SHORTCUTS,
  questionFilterCounts,
  QuestionFiltersSchema,
  questionInView,
  questionPanelKeyAction,
  questionPanelOrder,
  resolveSelectedQuestionId,
  toggleQuestionFilter,
  type QuestionFilter,
} from "./ThreadQuestionsPanel.logic";
import { requestQuestionReveal } from "./questionReveal";
import { serverEnvironment } from "../../state/server";
import { selectThreadTileLayout, useRightPanelStore } from "../../rightPanelStore";
import { CONVERSATION_TAB_ID, getTileGroups } from "../../threadTileLayout";

const FILTER_LABELS: Record<QuestionFilter, string> = {
  waiting: "Waiting",
  deferred: "Deferred",
  answered: "Answered",
  dismissed: "Dismissed",
};

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
 * Every question of a thread beside the chat: a sectioned list that jumps to and follows one
 * scrolling column of full cards, and a button that queues every drafted answer in the composer.
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
  const columnRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves keyboard focus into the panel as its tab is shown, so its keys never reach a hidden composer
  useEffect(() => {
    const root = rootRef.current;
    if (active && root && !root.contains(document.activeElement))
      root.focus({ preventScroll: true });
  }, [active]);
  const { workspace, error } = useThreadQuestionsWorkspace(threadRef, true);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const canAct = useAtomValue(threadQuestionDraft.permissionAtom(threadRef.environmentId));
  const saveDraft = useSaveQuestionDraft(threadRef);
  const writer = questionDraftWriter(scopedThreadKey(threadRef));
  const update = useAtomCommand(threadQuestionUpdate);
  const inComposer = useQuestionsInComposer(threadRef);
  const [filters, setFilters] = useLocalStorage(
    QUESTION_FILTERS_STORAGE_KEY,
    DEFAULT_QUESTION_FILTERS,
    QuestionFiltersSchema,
  );
  const allQuestions = workspace?.questions ?? [];
  const filterCounts = questionFilterCounts(allQuestions);
  const questions = filterQuestions(allQuestions, filters);
  const order = questionPanelOrder(questions);
  const sections = sectionThreadQuestions(questions);
  const shownId = resolveSelectedQuestionId(order, focusedId);
  const toAdd = allQuestions.filter(
    (question) => threadQuestionHasDraft(question) && !inComposer.has(question.id),
  ).length;

  const cardOf = (id: string) =>
    columnRef.current?.querySelector<HTMLElement>(`[data-question-card="${CSS.escape(id)}"]`);
  const jumpTo = (id: string) => {
    setFocusedId(id);
    cardOf(id)?.scrollIntoView({ block: "start" });
    rootRef.current
      ?.querySelector(`[data-question-item="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };
  const followScroll = () => {
    const column = columnRef.current;
    if (!column) return;
    const view = column.getBoundingClientRect();
    const id = questionInView(
      [...column.querySelectorAll<HTMLElement>("[data-question-card]")].map((card) => {
        const rect = card.getBoundingClientRect();
        return { id: card.dataset.questionCard ?? "", top: rect.top, bottom: rect.bottom };
      }),
      { top: view.top, bottom: view.bottom },
      shownId,
    );
    if (id !== null && id !== shownId) {
      setFocusedId(id);
      rootRef.current
        ?.querySelector(`[data-question-item="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };
  // The card on screen stays where it is as cards above it come and go.
  const toggleFilter = (filter: QuestionFilter) => {
    const column = columnRef.current;
    const anchorId = shownId !== null && cardOf(shownId) ? shownId : null;
    const before = anchorId === null ? null : cardOf(anchorId)!.getBoundingClientRect().top;
    flushSync(() => setFilters(toggleQuestionFilter(filters, filter)));
    const after = anchorId === null ? null : cardOf(anchorId)?.getBoundingClientRect().top;
    if (column && before !== null && after !== undefined && after !== null)
      column.scrollTop += after - before;
  };
  const addDrafted = async () => {
    setAdding(true);
    await addDraftedAnswersToComposer({
      threadRef,
      workspace: workspace ?? null,
      writer,
      saveDraft,
    });
    setAdding(false);
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
        jumpTo(action.id);
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
      ) : allQuestions.length === 0 ? (
        <p className="flex-1 p-4 text-sm text-muted-foreground">
          No questions yet. When an agent asks one, it shows here and in the chat.
        </p>
      ) : (
        <>
          <div
            role="group"
            aria-label="Show questions"
            className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2"
          >
            {QUESTION_FILTERS.map((filter) => (
              <Toggle
                key={filter}
                variant="pill"
                size="segmented"
                pressed={filters.includes(filter)}
                onPressedChange={() => toggleFilter(filter)}
              >
                {FILTER_LABELS[filter]} {filterCounts[filter]}
              </Toggle>
            ))}
          </div>
          {questions.length === 0 ? (
            <p className="flex-1 p-4 text-sm text-muted-foreground">
              No questions match these filters.
            </p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col @min-[560px]:flex-row">
              <nav
                aria-label="Questions"
                className="max-h-[35%] shrink-0 overflow-y-auto border-b border-border p-2 @min-[560px]:max-h-none @min-[560px]:w-56 @min-[560px]:border-r @min-[560px]:border-b-0"
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
                              onClick={() => jumpTo(question.id)}
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
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ),
                )}
              </nav>
              <div
                ref={columnRef}
                onScroll={followScroll}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3"
              >
                {THREAD_QUESTION_SECTIONS.map((section) =>
                  sections[section].length === 0 ? null : (
                    <section
                      key={section}
                      aria-label={SECTION_LABELS[section]}
                      className="space-y-2 pb-3"
                    >
                      <h3 className="text-xs font-medium text-muted-foreground">
                        {SECTION_LABELS[section]}
                      </h3>
                      {sections[section].map((question) => (
                        <div
                          key={question.id}
                          data-question-card={question.id}
                          className={cn(
                            "scroll-mt-3 rounded-lg",
                            question.id === shownId && "ring-1 ring-ring/40",
                          )}
                        >
                          <ThreadQuestionCard
                            question={question}
                            threadRef={threadRef}
                            actions={
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => showInChat(question.id)}
                              >
                                Show in chat
                              </Button>
                            }
                          />
                        </div>
                      ))}
                    </section>
                  ),
                )}
              </div>
            </div>
          )}
        </>
      )}
      <footer className="flex shrink-0 items-center gap-3 border-t border-border p-3 pe-9">
        {/* One line that gives way to Answer N, so the button never moves. */}
        <p className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd> move · <Kbd>1</Kbd>–<Kbd>9</Kbd> choose · <Kbd>N</Kbd> defer
        </p>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              size="sm"
              disabled={!canAct || toAdd === 0 || adding}
              onClick={() => void addDrafted()}
            >
              Answer {toAdd}
            </Button>
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-72">
            {toAdd === 0
              ? "Choose an option or add a note to a question first."
              : "Queue every drafted answer to go with your next message. Questions you are discussing are left out."}
          </TooltipPopup>
        </Tooltip>
      </footer>
    </div>
  );
}
