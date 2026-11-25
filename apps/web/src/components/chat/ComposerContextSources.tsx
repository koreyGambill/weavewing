import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadDefaultContextGet } from "../../state/threadInsights";
import {
  homeOf,
  shortenPath,
  type UsedContextSource,
  usedContextSources,
} from "../insights/defaultContext.logic";
import { MiddleTruncate } from "../ui/middle-truncate";

const approx = (tokens: number) => `~${formatContextWindowTokens(tokens)}`;

/**
 * What the used context is made of. Mounted only inside the open popup, so a closed ring sends
 * nothing; it reuses the Default context preview rather than measuring anything itself.
 */
export function ComposerContextSources({
  threadRef,
  usedTokens,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly usedTokens: number;
}) {
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    canRead
      ? threadDefaultContextGet({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
  const [open, setOpen] = useState<string | null>(null);
  if (!canRead) return null;
  if (query.error)
    return (
      <p className="mt-3 text-muted-foreground text-xs">Could not estimate what's using it.</p>
    );
  const preview = query.data;
  if (preview == null)
    return <p className="mt-3 text-muted-foreground text-xs">Estimating what's using it…</p>;
  const breakdown = usedContextSources(preview, usedTokens);
  if (breakdown === null) return null;
  if (!breakdown.reconciles)
    return (
      <p className="mt-3 text-muted-foreground text-xs">
        T3's byte-based estimates of what it adds ({approx(breakdown.knownTokens)}) exceed the
        provider's count ({formatContextWindowTokens(breakdown.usedTokens)}), so they can't break it
        down. Default context in the Inspect panel lists them.
      </p>
    );
  const home = homeOf([
    ...(preview.cwd ? [preview.cwd] : []),
    ...preview.items.map((item) => item.label),
  ]);
  const notVisible = preview.notVisible.map((entry) => entry.label);
  return (
    <>
      <p className="mt-3 text-muted-foreground text-xs">What's using it, estimated</p>
      <ul className="mt-1 flex flex-col text-xs" aria-label="What's using the context">
        {breakdown.sources.map((source) => {
          const expanded = open === source.key;
          const detailsId = `composer-context-source-${source.key}`;
          return (
            <li key={source.key}>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setOpen(expanded ? null : source.key)}
                className="-mx-1 flex w-[calc(100%+--spacing(2))] items-start gap-1 rounded-sm px-1 py-0.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-3 shrink-0 text-muted-foreground",
                    expanded && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1">{source.label}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {approx(source.tokens)}
                </span>
              </button>
              {expanded ? (
                <div id={detailsId} className="mb-1 ml-4">
                  <SourceDetails
                    source={source}
                    home={home}
                    knownTokens={breakdown.knownTokens}
                    firstTurnTokens={breakdown.firstTurnTokens}
                    usedTokens={usedTokens}
                    notVisible={notVisible}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SourceDetails({
  source,
  home,
  knownTokens,
  firstTurnTokens,
  usedTokens,
  notVisible,
}: {
  readonly source: UsedContextSource;
  readonly home: string | null;
  readonly knownTokens: number;
  readonly firstTurnTokens: number | null;
  readonly usedTokens: number;
  readonly notVisible: ReadonlyArray<string>;
}) {
  if (source.items.length > 0)
    return (
      <ul className="max-h-32 overflow-y-auto text-muted-foreground">
        {source.items.map((item) => (
          <li key={item.id} className="flex items-baseline gap-2">
            <MiddleTruncate
              className="min-w-0 flex-1"
              value={item.category === "files" ? shortenPath(item.label, home) : item.label}
            />
            <span className="shrink-0 tabular-nums">{approx(item.estimatedTokens)}</span>
          </li>
        ))}
      </ul>
    );
  const explanation =
    source.key === "conversation"
      ? `Messages, tool calls and their output: the latest report (${formatContextWindowTokens(usedTokens)}) minus the first turn's prompt (${formatContextWindowTokens(firstTurnTokens)}). Compaction shrinks it.`
      : source.key === "harness"
        ? `The first turn's prompt as the provider reported it (${formatContextWindowTokens(firstTurnTokens)}) minus the parts T3 can itemize (${approx(knownTokens)}). It also holds your first message and anything that turn read.`
        : `The latest report (${formatContextWindowTokens(usedTokens)}) minus the parts T3 can itemize (${approx(knownTokens)}). No first-turn report can separate them, because the thread was forked, handed off, imported or compacted, or the provider never sent one, so this includes the conversation.`;
  return (
    <div className="text-muted-foreground">
      <p>{explanation}</p>
      {source.key !== "conversation" && notVisible.length > 0 ? (
        <ul className="mt-0.5 list-disc pl-4">
          {notVisible.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
