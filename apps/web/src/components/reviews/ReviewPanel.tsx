import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ReviewId,
  type ReviewArtifact,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ArrowLeftIcon, CheckCheckIcon, PlusIcon, ListIcon, SendIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import {
  reviewArtifactCreate,
  reviewArtifactGet,
  reviewArtifactsList,
  type ReviewTarget,
} from "../../state/reviews";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import ChatMarkdown from "../ChatMarkdown";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ReviewQuestionCard, emptyReviewAnswer } from "./ReviewQuestionCard";
import { ReviewNotes, type ReviewQuote } from "./ReviewNotes";
import { ReviewReminderMenu } from "./ReviewReminderMenu";
import { useReviewSupport } from "./useReviewSupport";
import {
  editReviewDraft,
  flushReviewDraft,
  resolveReviewConflict,
  sendReview,
  useReviewDraft,
} from "./reviewDrafts";
import { APP_BASE_NAME } from "~/branding";

const isReviewId = Schema.is(ReviewId);

export function ReviewPanel({
  threadRef,
  reviewId,
  visible,
  startedThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly reviewId: string | null;
  readonly visible: boolean;
  readonly startedThread: boolean;
}) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const supported = useReviewSupport(threadRef.environmentId);
  const canWrite = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const [creating, setCreating] = useState(false);
  const now = Date.parse(`${useNowMinute()}Z`);
  const list = useEnvironmentQuery(
    visible && canRead && supported && startedThread
      ? reviewArtifactsList({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const validId = isReviewId(reviewId) ? reviewId : null;
  const query = useEnvironmentQuery(
    visible && canRead && supported && startedThread && validId
      ? reviewArtifactGet({ environmentId: threadRef.environmentId, input: { reviewId: validId } })
      : null,
  );
  const open = (id?: string) =>
    useThreadContextSidebarStore
      .getState()
      .show("artifacts", { thread: threadRef, ...(id ? { artifactId: id } : {}) });
  if (!startedThread)
    return (
      <p className="p-5 text-sm text-muted-foreground">
        Send the first message in this conversation to create or open reviews.
      </p>
    );
  if (!supported)
    return (
      <p className="p-5 text-sm text-muted-foreground">
        Reviews are unavailable on this environment. Connect to a {APP_BASE_NAME} build with review
        support.
      </p>
    );
  if (!canRead)
    return (
      <p className="p-5 text-sm text-muted-foreground">This connection cannot read reviews.</p>
    );
  return (
    <div className="@container/review flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {reviewId === null ? (
        <>
          <div className="flex h-7 shrink-0 items-center justify-end border-b border-border px-1">
            <Button
              size="micro"
              variant="ghost"
              disabled={!canWrite}
              onClick={() => setCreating(true)}
            >
              <PlusIcon className="size-3.5" />
              Create review
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {list.data?.map((review) => (
              <button
                key={review.id}
                type="button"
                className="flex w-full items-start justify-between gap-3 rounded-xl border border-border p-4 text-left hover:bg-muted/40"
                onClick={() => open(review.id)}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{review.title}</span>
                  <span className="mt-2 block text-xs text-muted-foreground">
                    Updated <RelativeTime timestamp={review.updatedAt} />
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {review.lastSubmittedRevision === review.revision
                    ? "Sent"
                    : review.remindAt
                      ? Date.parse(review.remindAt) <= now
                        ? "Due"
                        : "Deferred"
                      : "Needs review"}
                </span>
              </button>
            ))}
            {list.data?.length === 0 ? (
              <div className="space-y-2 py-10 text-center">
                <p className="text-sm font-medium">Make the next decision easier.</p>
                <p className="text-sm text-muted-foreground">
                  Ask your agent to create a review, or start one here.
                </p>
              </div>
            ) : null}
            {list.isPending && list.data === null ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading reviews…
              </p>
            ) : null}
            {list.error ? (
              <p role="alert" className="text-sm text-destructive">
                {list.error}
              </p>
            ) : null}
          </div>
        </>
      ) : query.data && validId ? (
        <ReviewDocument
          key={reviewId}
          threadRef={threadRef}
          target={{ environmentId: threadRef.environmentId, reviewId: validId }}
          artifact={query.data}
          canWrite={canWrite}
          onBack={() => open()}
          onRefresh={query.refresh}
        />
      ) : (
        <div className="space-y-4 p-5">
          <Button size="sm" variant="ghost" onClick={() => open()}>
            <ArrowLeftIcon className="size-3.5" />
            All reviews
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {query.error ?? (validId ? "Loading review…" : "This review is unavailable.")}
          </p>
        </div>
      )}
      {creating ? (
        <CreateReview
          threadRef={threadRef}
          onClose={() => setCreating(false)}
          onCreated={(artifact) => {
            setCreating(false);
            list.refresh();
            open(artifact.id);
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewDocument({
  threadRef,
  target,
  artifact,
  canWrite,
  onBack,
  onRefresh,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly target: ReviewTarget;
  readonly artifact: ReviewArtifact;
  readonly canWrite: boolean;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
}) {
  const session = useReviewDraft(target, artifact);
  const now = Date.parse(`${useNowMinute()}Z`);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selectedSection, setSelectedSection] = useState(artifact.content.sections[0]?.id ?? "");
  const [quotes, setQuotes] = useState<Readonly<Record<string, ReviewQuote>>>({});
  if (!session) return null;
  const { draft } = session;
  const disabled = !canWrite || session.submitting;
  const questions = artifact.content.sections.flatMap((section) => section.questions);
  const answered = questions.filter((question) => {
    const answer = draft.answers[question.id];
    return (
      answer && !answer.deferred && (answer.selectedOptionIds.length > 0 || answer.notes.trim())
    );
  }).length;
  const sent =
    !session.dirty && session.artifact.lastSubmission?.revision === session.artifact.revision;
  const hasResponse =
    draft.notes.trim().length > 0 ||
    draft.annotations.length > 0 ||
    Object.values(draft.answers).some(
      (answer) =>
        answer.deferred || answer.selectedOptionIds.length > 0 || answer.notes.trim().length > 0,
    );
  const jump = (id: string) => {
    setSelectedSection(id);
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-review-section="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const outline = artifact.content.sections.map((section) => (
    <button
      key={section.id}
      type="button"
      aria-current={selectedSection === section.id ? "location" : undefined}
      className="w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted aria-current:bg-muted aria-current:text-foreground"
      onClick={() => jump(section.id)}
    >
      {section.title}
    </button>
  ));
  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border px-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-micro" aria-label="All reviews" onClick={onBack} />
            }
          >
            <ArrowLeftIcon />
          </TooltipTrigger>
          <TooltipPopup>All reviews</TooltipPopup>
        </Tooltip>
        <Popover>
          <PopoverTrigger
            render={<Button variant="ghost" size="icon-micro" aria-label="Review outline" />}
          >
            <ListIcon />
          </PopoverTrigger>
          <PopoverPopup align="start" padding="compact">
            <nav aria-label="Review sections" className="max-h-64 w-52 overflow-auto">
              {outline}
            </nav>
          </PopoverPopup>
        </Popover>
        <div className="min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger render={<h2 tabIndex={0} className="truncate text-xs font-medium" />}>
              {artifact.content.title}
            </TooltipTrigger>
            <TooltipPopup>{artifact.content.title}</TooltipPopup>
          </Tooltip>
        </div>
        <span
          aria-label={`${answered} of ${questions.length} answered`}
          className="shrink-0 text-2xs tabular-nums text-muted-foreground"
        >
          {answered}/{questions.length}
        </span>
        {draft.remindAt && !sent ? (
          <span className="shrink-0 text-2xs text-muted-foreground">
            {Date.parse(draft.remindAt) <= now ? "Due " : "Reminder "}
            <RelativeTime timestamp={draft.remindAt} />
          </span>
        ) : null}
        <span role="status" className="shrink-0 text-2xs text-muted-foreground">
          {session.submitting
            ? "Sending…"
            : session.saving
              ? "Saving…"
              : session.error || session.dirty
                ? "Unsaved"
                : sent
                  ? "Sent to chat"
                  : "Saved"}
        </span>
        <ReviewReminderMenu
          disabled={disabled}
          remindAt={sent ? null : draft.remindAt}
          onChange={(remindAt) => {
            editReviewDraft(target, (current) => ({ ...current, remindAt }));
            void flushReviewDraft(target);
          }}
        />
        <Button
          size="icon-micro"
          aria-label={
            session.submitting ? "Sending…" : sent ? "Sent to chat" : "Send review to chat"
          }
          disabled={disabled || session.conflict || sent || !hasResponse}
          onClick={() => {
            void sendReview(target);
          }}
        >
          {sent ? <CheckCheckIcon /> : <SendIcon />}
        </Button>
      </div>
      {session.error ? (
        <div
          role="alert"
          className="space-y-2 border-b border-border bg-destructive/5 px-5 py-3 text-xs"
        >
          <p className="text-destructive">{session.error}</p>
          <div className="flex flex-wrap gap-2">
            {session.conflict ? (
              <>
                <Button variant="outline" size="xs" onClick={onRefresh}>
                  Refresh saved review
                </Button>
                {session.remote.revision > session.artifact.revision ? (
                  <>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => resolveReviewConflict(target, false)}
                    >
                      Use saved answers
                    </Button>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => resolveReviewConflict(target, true)}
                    >
                      Replace saved answers with mine
                    </Button>
                  </>
                ) : null}
              </>
            ) : (
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  void (session.dirty ? flushReviewDraft(target) : sendReview(target));
                }}
              >
                {session.dirty ? "Retry save" : "Retry send"}
              </Button>
            )}
          </div>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-2">
          {artifact.content.summary ? (
            <div className="text-sm text-muted-foreground">
              <ChatMarkdown text={artifact.content.summary} cwd={undefined} threadRef={threadRef} />
            </div>
          ) : null}
          {artifact.content.sections.map((section) => (
            <section
              key={section.id}
              data-review-section={section.id}
              className="scroll-mt-5 space-y-4"
              onPointerUp={(event) => {
                const selection = window.getSelection();
                const quote = selection?.toString().trim();
                if (
                  !quote ||
                  !selection?.anchorNode ||
                  !selection.focusNode ||
                  !event.currentTarget.contains(selection.anchorNode) ||
                  !event.currentTarget.contains(selection.focusNode)
                )
                  return;
                const element =
                  selection.anchorNode instanceof Element
                    ? selection.anchorNode
                    : selection.anchorNode.parentElement;
                setQuotes((current) => ({
                  ...current,
                  [section.id]: {
                    quote,
                    questionId:
                      element?.closest<HTMLElement>("[data-review-question]")?.dataset
                        .reviewQuestion ?? null,
                  },
                }));
              }}
            >
              <h3 className="text-base font-semibold">{section.title}</h3>
              {section.markdown ? (
                <ChatMarkdown text={section.markdown} cwd={undefined} threadRef={threadRef} />
              ) : null}
              {section.questions.map((question) => (
                <ReviewQuestionCard
                  key={question.id}
                  question={question}
                  answer={draft.answers[question.id] ?? emptyReviewAnswer}
                  threadRef={threadRef}
                  disabled={disabled}
                  onChange={(answer) =>
                    editReviewDraft(target, (current) => ({
                      ...current,
                      answers: { ...current.answers, [question.id]: answer },
                    }))
                  }
                />
              ))}
              <ReviewNotes
                sectionId={section.id}
                annotations={draft.annotations}
                quote={quotes[section.id] ?? null}
                disabled={disabled}
                onChange={(annotations) =>
                  editReviewDraft(target, (current) => ({ ...current, annotations }))
                }
              />
            </section>
          ))}
          <label className="block space-y-2 text-sm font-medium">
            Overall notes
            <Textarea
              aria-label="Overall review notes"
              value={draft.notes}
              disabled={disabled}
              placeholder="Anything else the agent should know…"
              onChange={(event) =>
                editReviewDraft(target, (current) => ({ ...current, notes: event.target.value }))
              }
            />
          </label>
        </div>
      </div>
    </>
  );
}

function CreateReview({
  threadRef,
  onClose,
  onCreated,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
  readonly onCreated: (artifact: ReviewArtifact) => void;
}) {
  const create = useAtomCommand(reviewArtifactCreate, "create review");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (pending || !title.trim() || !question.trim()) return;
    setPending(true);
    const result = await create({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        content: {
          title: title.trim(),
          summary,
          sections: [
            {
              id: "decisions",
              title: "Decisions",
              markdown: "",
              questions: [
                {
                  id: "question-1",
                  prompt: question.trim(),
                  context: "",
                  recommendation: "",
                  recommendedOptionId: null,
                  multiSelect: false,
                  options: options
                    .split("\n")
                    .filter((line) => line.trim())
                    .map((label, index) => ({
                      id: `option-${index + 1}`,
                      label: label.trim(),
                      description: "",
                    })),
                },
              ],
            },
          ],
        },
      },
    });
    setPending(false);
    if (result._tag === "Success") onCreated(result.value);
    else {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not create review.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create a review</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <label className="block space-y-2 text-sm">
                Title
                <Input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="A decision to make"
                />
              </label>
              <label className="block space-y-2 text-sm">
                Context
                <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
              </label>
              <label className="block space-y-2 text-sm">
                Question
                <Textarea value={question} onChange={(event) => setQuestion(event.target.value)} />
              </label>
              <label className="block space-y-2 text-sm">
                Options, one per line
                <Textarea
                  value={options}
                  onChange={(event) => setOptions(event.target.value)}
                  placeholder="Leave empty for a written answer"
                />
              </label>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !title.trim() || !question.trim()}>
              {pending ? "Creating…" : "Create review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
