import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  threadQuestionReferenceMode,
  type SentContextBlock,
  type SentContextSection,
} from "@t3tools/shared/sentContext";
import { ChevronDownIcon } from "lucide-react";
import {
  createContext,
  use,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { agentQuestionsEnvironmentIdsAtom } from "~/state/threadQuestions";
import { revealQuestionInChat } from "../questions/questionReveal";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { findRevealRef } from "./markdownFindContext";
import { questionReferenceElementId } from "./questionReferences";
import { useQuestionReferenceMark } from "./questionReferenceReveal";
import { TimelineRowCtx } from "./timelineRowContext";

interface SentContextExpansion {
  readonly messageId: string;
  readonly blocks: readonly SentContextBlock[];
  readonly expanded: ReadonlySet<string>;
  readonly panelIdPrefix: string;
  readonly setExpanded: (contextIds: ReadonlyArray<string>, open: boolean) => void;
}

const SentContextExpansionCtx = createContext<SentContextExpansion | null>(null);

const KIND_NAMES: Record<string, string> = {
  terminal: "Terminal output",
  element: "Browser element",
  "preview-annotation": "Preview annotation",
  "review-comment": "Review comment",
  response: "Replied-to response",
  thread: "Thread",
};

const kindName = (block: SentContextBlock) => KIND_NAMES[block.kind] ?? block.kind;

/**
 * Which of a message's references are open. Kept per mounted message, never persisted, so a
 * message scrolled out of the list opens collapsed again.
 */
export function SentContextExpansionProvider(props: {
  messageId: string;
  blocks: readonly SentContextBlock[];
  children: ReactNode;
}) {
  const panelIdPrefix = useId();
  const [state, setState] = useState<{ messageId: string; open: ReadonlySet<string> }>(() => ({
    messageId: props.messageId,
    open: new Set(),
  }));
  const open = state.messageId === props.messageId ? state.open : new Set<string>();
  const value: SentContextExpansion = {
    messageId: props.messageId,
    blocks: props.blocks,
    expanded: open,
    panelIdPrefix,
    setExpanded: (contextIds, next) =>
      setState((current) => {
        const ids = new Set(current.messageId === props.messageId ? current.open : []);
        for (const contextId of contextIds) {
          if (next) ids.add(contextId);
          else ids.delete(contextId);
        }
        return { messageId: props.messageId, open: ids };
      }),
  };
  return <SentContextExpansionCtx value={value}>{props.children}</SentContextExpansionCtx>;
}

const panelId = (expansion: SentContextExpansion, contextId: string) =>
  `${expansion.panelIdPrefix}-${contextId}`;

/** The control beside a reference chip that opens what it sent under the message. */
export function SentContextExpandToggle(props: { contextId: string }) {
  const expansion = use(SentContextExpansionCtx);
  const block = expansion?.blocks.find(
    (candidate) => candidate.contextId === props.contextId && candidate.display === "expandable",
  );
  if (!expansion || !block) return null;
  const open = expansion.expanded.has(block.contextId);
  const action = `${open ? "Hide" : "Show"} what ${block.label} sent`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={action}
            aria-expanded={open}
            aria-controls={open ? panelId(expansion, block.contextId) : undefined}
            data-scroll-anchor-ignore
            onClick={() => {
              expansion.setExpanded([block.contextId], !open);
            }}
          />
        }
      >
        <ChevronDownIcon
          className={cn("transition-transform duration-150", open && "rotate-180")}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{action}</TooltipPopup>
    </Tooltip>
  );
}

function SectionBody({ section }: { section: SentContextSection }) {
  return section.preformatted ? (
    <pre className="overflow-x-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre">
      {section.text}
    </pre>
  ) : (
    <div className="whitespace-pre-wrap wrap-break-word">{section.text}</div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div data-thread-find-ignore className="text-2xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/** A question prompt clamped to three lines, with a "more" control when it overflows. */
function ClampedQuestion({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- whether three lines clip the prompt depends on the rendered width, which only the DOM knows
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    return observeResize(element, measure);
  }, [expanded]);
  const clamped = overflows && !expanded;
  const revealRef = findRevealRef(() => setExpanded(true));
  return (
    <div>
      <div
        ref={(element) => {
          ref.current = element;
          return revealRef(element);
        }}
        data-thread-find-fold={clamped ? "" : undefined}
        className={cn(
          "whitespace-pre-wrap wrap-break-word text-muted-foreground",
          !expanded && "line-clamp-3",
        )}
      >
        {text}
      </div>
      {overflows || expanded ? (
        <span data-thread-find-ignore>
          <InlineButton
            tone="muted"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "less" : "more"}
          </InlineButton>
        </span>
      ) : null}
    </div>
  );
}

function AnswerBlock({ block, messageId }: { block: SentContextBlock; messageId: string }) {
  const ctx = use(TimelineRowCtx);
  const enabledIds = useAtomValue(agentQuestionsEnvironmentIdsAtom);
  const record = block.record.kind === "artifact-answer" ? block.record : null;
  const mode = threadQuestionReferenceMode(block.record);
  const questionId = record && mode !== null ? record.questionId : null;
  const marked = useQuestionReferenceMark(ctx.threadRef, messageId, questionId ?? "");
  if (!record) return null;
  const threadRef = ctx.threadRef;
  const canShowQuestion =
    questionId !== null && threadRef !== null && enabledIds.includes(threadRef.environmentId);
  const [question, ...rest] = block.sections;
  const promptSection = question?.label === null ? question : null;
  const details = promptSection ? rest : block.sections;
  return (
    <div
      id={questionId === null ? undefined : questionReferenceElementId(messageId, questionId)}
      data-question-reference={questionId ?? undefined}
      data-marked={marked ? "" : undefined}
      className="rounded-lg border border-border/70 bg-background/50 px-3 py-2 text-sm transition-colors duration-500 data-marked:border-primary/60 data-marked:bg-primary/10"
    >
      <div data-thread-find-ignore className="mb-1 flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-medium">
          {questionId ?? record.title}
          {mode === "discuss" ? <span className="text-muted-foreground"> · comment</span> : null}
        </span>
        {canShowQuestion ? (
          <InlineButton
            tone="muted"
            className="ms-auto"
            onClick={() => revealQuestionInChat(scopedThreadKey(threadRef), questionId)}
          >
            Show question
          </InlineButton>
        ) : null}
      </div>
      <div className="space-y-1.5">
        {promptSection ? <ClampedQuestion text={promptSection.text} /> : null}
        {details.map((section) => (
          <div key={section.label ?? ""} className="space-y-0.5">
            {section.label === "Answer" ? (
              <div className="font-medium whitespace-pre-wrap wrap-break-word">{section.text}</div>
            ) : (
              <>
                {section.label ? <SectionLabel>{section.label}</SectionLabel> : null}
                <SectionBody section={section} />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReferencePanel(props: {
  block: SentContextBlock;
  expansion: SentContextExpansion;
  findActive: boolean;
}) {
  const { block, expansion, findActive } = props;
  const open = expansion.expanded.has(block.contextId);
  const revealRef = findRevealRef(() => expansion.setExpanded([block.contextId], true));
  // Collapsed panels mount only while find is open, as hidden text find can reveal.
  if (!open && !findActive) return null;
  return (
    <section
      ref={open ? undefined : revealRef}
      id={panelId(expansion, block.contextId)}
      hidden={!open}
      aria-label={`${kindName(block)}: ${block.label}`}
      className="overflow-hidden rounded-lg border border-border/70 bg-background/50 text-sm"
    >
      <div
        data-thread-find-ignore
        className="truncate border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="font-medium text-foreground">{kindName(block)}</span> · {block.label}
      </div>
      {/* Find scrolls the list to a match, so the cap lifts while find is open. */}
      <div className={cn("space-y-2 px-3 py-2", !findActive && "max-h-80 overflow-auto")}>
        {/* Section labels are unique within a block; element sections are numbered when several. */}
        {block.sections.map((section) => (
          <div key={section.label ?? ""} className="space-y-0.5">
            {section.label ? <SectionLabel>{section.label}</SectionLabel> : null}
            <SectionBody section={section} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * What a sent message's references carried, under its text: answers always, other references
 * when opened from their chip or by find. Render order matches the server's find index.
 */
export function SentContextBlocks() {
  const expansion = use(SentContextExpansionCtx);
  const { findActive } = use(TimelineRowCtx);
  if (!expansion || expansion.blocks.length === 0) return null;
  const expandable = expansion.blocks.filter((block) => block.display === "expandable");
  const allOpen = expandable.every((block) => expansion.expanded.has(block.contextId));
  return (
    <div data-thread-find-text="true" className="mt-2 flex flex-col gap-2">
      {expandable.length > 1 ? (
        <div data-thread-find-ignore className="flex justify-end">
          <Button
            size="xs"
            variant="ghost-muted"
            aria-expanded={allOpen}
            data-scroll-anchor-ignore
            onClick={() => {
              expansion.setExpanded(
                expandable.map((block) => block.contextId),
                !allOpen,
              );
            }}
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      ) : null}
      {expansion.blocks.map((block) =>
        block.display === "open" ? (
          <AnswerBlock key={block.contextId} block={block} messageId={expansion.messageId} />
        ) : (
          <ReferencePanel
            key={block.contextId}
            block={block}
            expansion={expansion}
            findActive={findActive}
          />
        ),
      )}
    </div>
  );
}
