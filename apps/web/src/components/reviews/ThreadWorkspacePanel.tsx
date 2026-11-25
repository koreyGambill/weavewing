import {
  AuthOrchestrationReadScope,
  type ArtifactAnswerContextRecord,
  type ArtifactQuestion,
  type ScopedThreadRef,
  type ThreadArtifact,
  type ThreadArtifactVersion,
  type ThreadWorkspace,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { CheckIcon, MessageSquarePlusIcon, SendIcon } from "lucide-react";
import { toComposerContextId } from "@t3tools/shared/composerContextReferences";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import { environmentThreadDetails } from "../../state/threads";
import { useWorkspaceMutationRefresh } from "../../hooks/useWorkspaceMutationRefresh";
import { randomUUID } from "../../lib/utils";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadWorkspaceGet, threadArtifactAnswer } from "../../state/threadWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { QuestionOptions } from "../questions/QuestionOptions";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

type AnswerDraft = { chosenOptionIds: readonly string[]; notes: string };
const latestUserMessageId = (items: readonly ThreadStructureVisibleTurnItem[]) =>
  items.findLast((entry) => entry.item.type === "user_message")?.item.id ?? null;

export function ArtifactsPanel({
  threadRef,
  selectedId,
  workspaceMutationId,
  composerDraftTarget,
  inSidebar = false,
}: {
  threadRef: ScopedThreadRef;
  selectedId: string | null;
  workspaceMutationId: string | null;
  composerDraftTarget: ComposerThreadTarget;
  inSidebar?: boolean;
}) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    canRead
      ? threadWorkspaceGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const userMessageId = useAtomValue(
    environmentThreadDetails.quietVisibleTurnItemsAtom(threadRef),
    latestUserMessageId,
  );
  useWorkspaceMutationRefresh({
    enabled: canRead,
    mutationId: [workspaceMutationId, userMessageId].filter(Boolean).join(":") || null,
    resourceKey: `${threadRef.environmentId}:${threadRef.threadId}:artifacts`,
    refresh: query.refresh,
  });
  const [updated, setUpdated] = useState<ThreadWorkspace | null>(null);
  const workspace =
    updated && updated.revision > (query.data?.revision ?? 0) ? updated : query.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [versionNumber, setVersionNumber] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const canAnswer = useAtomValue(threadArtifactAnswer.permissionAtom(threadRef.environmentId));
  const artifact =
    workspace?.artifacts.find((entry) => entry.id === (selected ?? selectedId)) ??
    workspace?.artifacts[0];
  const version =
    artifact?.versions.find((entry) => entry.version === versionNumber) ??
    artifact?.versions.at(-1);
  const ready =
    workspace?.artifacts
      .filter((entry) => entry.id === artifact?.id)
      .flatMap((entry) => {
        const latest = entry.versions.at(-1);
        return latest
          ? latest.questions.flatMap((question): ArtifactAnswerContextRecord[] => {
              const answer = latest.answers[question.id];
              if (
                !answer ||
                answer.submittedAt ||
                (!answer.chosenOptionIds.length && !answer.notes.trim())
              )
                return [];
              return [
                {
                  version: 1,
                  kind: "artifact-answer",
                  contextId: toComposerContextId(
                    `answer_${threadRef.threadId}:${entry.id}:${latest.version}:${question.id}:${answer.draftRevision ?? 0}`,
                  ),
                  label: `${latest.title}: ${question.prompt}`.slice(0, 200),
                  artifactId: entry.id,
                  title: latest.title.slice(0, 200),
                  artifactVersion: latest.version,
                  questionId: question.id,
                  answerRevision: answer.draftRevision ?? 0,
                  question: question.prompt,
                  choice: question.options
                    .filter((option) => answer.chosenOptionIds.includes(option.id))
                    .map((option) => option.label)
                    .join(", "),
                  note: answer.notes,
                },
              ];
            })
          : [];
      }) ?? [];
  const send = () => {
    useComposerDraftStore.getState().addArtifactAnswers(composerDraftTarget, ready);
    setNotice(
      `${ready.length} answer${ready.length === 1 ? "" : "s"} added to the composer. Send your message there.`,
    );
  };
  if (!workspace) return <p role="status">{query.error ?? "Loading artifacts…"}</p>;
  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-auto scrollbar-gutter-both">
      {artifact && version ? (
        <>
          <header
            className={`sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background ${inSidebar ? "pb-3" : "p-3"}`}
          >
            <div className="min-w-0 flex-1 basis-48">
              <Select
                value={artifact.id}
                onValueChange={(value) => {
                  setSelected(value);
                  setVersionNumber(null);
                }}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SelectTrigger size="sm" aria-label="Artifact" title={artifact.title} />
                    }
                  >
                    <span className="min-w-0 flex-1 truncate">{artifact.title}</span>
                  </TooltipTrigger>
                  <TooltipPopup>{artifact.title}</TooltipPopup>
                </Tooltip>
                <SelectPopup>
                  {workspace.artifacts.map((entry) => {
                    const current = entry.versions.at(-1);
                    const unanswered =
                      current?.questions.filter(
                        (question) => !current.answers[question.id]?.submittedAt,
                      ).length ?? 0;
                    return (
                      <SelectItem
                        key={entry.id}
                        value={entry.id}
                        label={entry.title}
                        title={entry.title}
                      >
                        <div className="flex max-w-96 items-center gap-3">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="min-w-0 flex-1 line-clamp-2 whitespace-normal break-words" />
                              }
                            >
                              {entry.title}
                            </TooltipTrigger>
                            <TooltipPopup>{entry.title}</TooltipPopup>
                          </Tooltip>
                          {unanswered ? (
                            <Badge variant="secondary" size="sm">
                              {unanswered}
                            </Badge>
                          ) : null}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            </div>
            <div className="w-48 max-w-full shrink-0">
              <Select value={version.version} onValueChange={setVersionNumber}>
                <SelectTrigger size="sm" aria-label="Artifact version">
                  <SelectValue>{`v${version.version} · ${new Date(version.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {artifact.versions.toReversed().map((entry) => (
                    <SelectItem key={entry.version} value={entry.version}>
                      v{entry.version} ·{" "}
                      {new Date(entry.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Badge size="sm" variant="outline">
              {version.format === "html" ? "HTML" : "Markdown"}
            </Badge>
            {version.questions.length ? (
              <Badge
                size="sm"
                variant={
                  version.questions.some((question) => !version.answers[question.id]?.submittedAt)
                    ? "warning"
                    : "success"
                }
              >
                {
                  version.questions.filter((question) => !version.answers[question.id]?.submittedAt)
                    .length
                }{" "}
                unanswered
              </Badge>
            ) : null}
          </header>
          <div className={inSidebar ? "py-4" : "px-3 py-4 @min-[320px]:px-6 @min-[320px]:py-6"}>
            <ArtifactDocument
              key={`${artifact.id}:${version.version}`}
              artifact={artifact}
              version={version}
              workspace={workspace}
              threadRef={threadRef}
              composerDraftTarget={composerDraftTarget}
              onRefresh={query.refresh}
              onSaved={(next) => {
                setUpdated(next);
                query.refresh();
              }}
            />
          </div>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">No artifacts yet.</p>
      )}
      {ready.length ? (
        <div
          className={`sticky bottom-0 mt-auto flex flex-wrap items-center gap-2 border-t border-border bg-background ${inSidebar ? "py-3" : "p-3"}`}
        >
          <div className="mx-auto grid w-full max-w-[72ch] grid-cols-1">
            <Button size="sm-multiline" disabled={!canAnswer} onClick={send}>
              <SendIcon />
              <span className="whitespace-normal">
                Send {ready.length} queued {ready.length === 1 ? "answer" : "answers"} to composer
              </span>
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="px-3 pb-3 text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function ArtifactDocument({
  artifact,
  version,
  workspace,
  threadRef,
  composerDraftTarget,
  onSaved,
  onRefresh,
}: {
  artifact: ThreadArtifact;
  version: ThreadArtifactVersion;
  workspace: ThreadWorkspace;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ComposerThreadTarget;
  onSaved: (next: ThreadWorkspace) => void;
  onRefresh: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [comment, setComment] = useState("");
  const [commentOpen, setCommentOpen] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = useAtomCommand(threadArtifactAnswer);
  const canAnswer = useAtomValue(threadArtifactAnswer.permissionAtom(threadRef.environmentId));
  const latest = artifact.versions.at(-1)?.version === version.version;
  const question = (entry: ArtifactQuestion) => {
    const answer = drafts[entry.id] ??
      version.answers[entry.id] ?? { chosenOptionIds: [], notes: "" };
    const edit = (change: Partial<AnswerDraft>) =>
      setDrafts({ ...drafts, [entry.id]: { ...answer, ...change } });
    const disabled = !latest || !canAnswer || busy;
    const saved = version.answers[entry.id];
    const status = drafts[entry.id]
      ? "Unsaved answer"
      : saved?.submittedAt
        ? "Sent to chat"
        : saved && (saved.chosenOptionIds.length || saved.notes.trim())
          ? "Answered · queued"
          : "Unanswered";
    return (
      <section
        key={entry.id}
        aria-label={entry.prompt}
        className="space-y-4 rounded-xl border border-border bg-background p-3 @min-[320px]:p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Question</span>
          <Badge
            variant={
              saved?.submittedAt && !drafts[entry.id]
                ? "success"
                : status === "Answered · queued"
                  ? "info"
                  : "secondary"
            }
            size="sm"
          >
            {saved?.submittedAt && !drafts[entry.id] ? <CheckIcon /> : null}
            {status}
          </Badge>
        </div>
        <h3 className="text-sm font-medium leading-relaxed">{entry.prompt}</h3>
        {entry.details ? (
          <ChatMarkdown text={entry.details} cwd={undefined} threadRef={threadRef} />
        ) : null}
        <QuestionOptions
          question={entry}
          chosenOptionIds={answer.chosenOptionIds}
          disabled={disabled}
          onChoose={(chosenOptionIds) => edit({ chosenOptionIds })}
        />
        <label className="block space-y-2 text-xs font-medium text-muted-foreground">
          Your answer or notes
          <Textarea
            aria-label={`Notes for ${entry.prompt}`}
            size="sm"
            placeholder="Add an answer, a constraint, or a reason…"
            value={answer.notes}
            disabled={disabled}
            onChange={(event) => edit({ notes: event.target.value })}
          />
        </label>
      </section>
    );
  };
  const parts = version.content
    .split(/^```t3-question[^\S\r\n]*\r?\n[\s\S]*?^```[^\S\r\n]*\r?$/gm)
    .map((part, index) => ({ part, entry: version.questions[index] }));
  return (
    <div className="mx-auto w-full max-w-[72ch] space-y-6">
      <div
        onMouseUp={(event) => {
          const selection = window.getSelection();
          if (
            !selection?.isCollapsed &&
            selection?.anchorNode &&
            selection.focusNode &&
            event.currentTarget.contains(selection.anchorNode) &&
            event.currentTarget.contains(selection.focusNode)
          ) {
            const text = selection.toString().trim();
            if (text) {
              setSelectedText(text);
              setCommentOpen(true);
            }
          }
        }}
        className="space-y-6"
      >
        {version.format === "html" ? (
          <iframe
            title={version.title}
            sandbox=""
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><style>body{font:14px system-ui;color-scheme:light dark;margin:16px}</style>${version.content}`}
            className="h-96 w-full rounded border border-border"
          />
        ) : (
          parts.map(({ part, entry }) => (
            <div key={entry ? `question:${entry.id}` : "tail"} className="space-y-3">
              {part.trim() ? (
                <ChatMarkdown text={part} cwd={undefined} threadRef={threadRef} />
              ) : null}
              {entry ? question(entry) : null}
            </div>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {latest && version.questions.length ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!Object.keys(drafts).length || busy || !canAnswer}
            onClick={async () => {
              setBusy(true);
              {
                const result = await save({
                  environmentId: threadRef.environmentId,
                  input: {
                    threadId: threadRef.threadId,
                    id: artifact.id,
                    version: version.version,
                    expectedRevision: workspace.revision,
                    answers: Object.fromEntries(
                      Object.entries(drafts).map(([id, answer]) => [
                        id,
                        { ...answer, submittedAt: null },
                      ]),
                    ),
                  },
                });
                if (result._tag === "Success") {
                  onSaved(result.value);
                  setDrafts({});
                }
              }
              onRefresh();
              setBusy(false);
            }}
          >
            Queue answers
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={!canAnswer}
          onClick={() => setCommentOpen(true)}
        >
          <MessageSquarePlusIcon />
          Comment
        </Button>
      </div>
      {commentOpen ? (
        <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
          {selectedText ? (
            <blockquote className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
              {selectedText}
            </blockquote>
          ) : null}
          <Textarea
            autoFocus
            aria-label="Artifact review comment"
            placeholder="Add a review comment…"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm-multiline"
              variant="outline"
              disabled={!comment.trim() || !canAnswer}
              onClick={() => {
                useComposerDraftStore.getState().addReviewComment(composerDraftTarget, {
                  id: randomUUID(),
                  sectionId: artifact.id,
                  sectionTitle: version.title.slice(0, 200),
                  filePath: `artifact:${artifact.id}@${version.version}`,
                  startIndex: 0,
                  endIndex: 0,
                  rangeLabel: `Version ${version.version}`,
                  text: comment,
                  diff: (selectedText || version.content).slice(0, 16000),
                  fenceLanguage: version.format,
                });
                setComment("");
                setSelectedText("");
                setCommentOpen(false);
              }}
            >
              Add comment to composer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCommentOpen(false);
                setComment("");
                setSelectedText("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
