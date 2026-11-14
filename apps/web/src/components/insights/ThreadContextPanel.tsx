import { AuthOrchestrationReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadContextGet } from "../../state/threadInsights";
import { createPortal } from "react-dom";
import { Button } from "../ui/button";
import { InspectControls, InspectRefreshButton } from "./InspectControls";

const number = (value: number | null) => (value === null ? "?" : value.toLocaleString());
export function ThreadContextPanel({
  threadRef,
  visible,
  headerActions,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly headerActions?: HTMLElement | null;
}) {
  const [beforeOrdinal, setBeforeOrdinal] = useState<number | undefined>();
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationReadScope);
  const query = useEnvironmentQuery(
    visible && canRead
      ? threadContextGet({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            limit: 5,
            ...(beforeOrdinal === undefined ? {} : { beforeOrdinal }),
          },
        })
      : null,
  );
  const refreshAction = (
    <InspectRefreshButton label="Refresh context" onClick={() => query.refresh()} />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {headerActions ? (
        createPortal(refreshAction, headerActions)
      ) : (
        <InspectControls>
          <div className="flex w-full items-center justify-end">{refreshAction}</div>
        </InspectControls>
      )}
      <div className="min-h-0 flex-1 overflow-auto scrollbar-gutter-both">
        <div className="mx-auto w-full max-w-4xl space-y-3 text-xs">
          <p className="text-muted-foreground">
            Context records by turn. Highlighted reads repeat or load at least 32 KB. Input tokens
            are billed input across model calls. ? means unavailable.
          </p>
          {!canRead ? (
            <p>Context access is unavailable.</p>
          ) : query.isPending ? (
            <p>Loading context…</p>
          ) : query.error ? (
            <p role="alert">Could not load context records.</p>
          ) : null}
          {query.data?.records.length === 0 && <p>No turns recorded yet.</p>}
          {query.data?.records.map((record) => (
            <details key={record.runId} className="rounded border p-2">
              <summary className="cursor-pointer">
                Turn {record.ordinal} · {record.model} · {record.repeatedReads} repeats
                {record.status === "rolled_back" ? " · rolled back" : ""}
                {record.truncated ? " · partial record" : ""}
              </summary>
              <table className="mt-2 w-full text-left tabular-nums">
                <caption className="sr-only">Turn {record.ordinal} token usage</caption>
                <thead>
                  <tr>
                    <th>Billed input across model calls</th>
                    <th>Cached</th>
                    <th>Output</th>
                    <th>Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{number(record.inputTokens)}</td>
                    <td>
                      {number(record.cachedInputTokens)}
                      {record.cachedInputTokensStatus === "partial" ? " (partial)" : ""}
                    </td>
                    <td>{number(record.outputTokens)}</td>
                    <td>{record.usageStatus}</td>
                  </tr>
                </tbody>
              </table>
              {record.instructions.map((snapshot) => (
                <div
                  key={`${snapshot.attemptId ?? snapshot.capturedAt}:${snapshot.providerTurnOrdinal ?? snapshot.source}`}
                  className="mt-2 space-y-1"
                >
                  <p className="text-muted-foreground">{snapshot.source}</p>
                  {snapshot.parts.map((part) => (
                    <p
                      key={`${part.key}:${part.label}:${part.category}`}
                      className={part.bytes >= 32000 ? "text-warning-foreground" : undefined}
                    >
                      {part.label}: {number(part.bytes)} bytes (~{number(part.estimatedTokens)}{" "}
                      tokens)
                    </p>
                  ))}
                  {snapshot.instructionSources?.map((source) => (
                    <p key={source.path} className="break-all">
                      {source.path}: {number(source.bytes)} bytes at capture
                    </p>
                  ))}
                  <details>
                    <summary>
                      Injected tools (
                      {snapshot.injectedToolCount ?? snapshot.injectedTools?.length ?? "?"})
                    </summary>
                    <p className="break-all text-muted-foreground">
                      {snapshot.injectedTools?.join(", ") ?? "Provider did not report tools."}
                      {snapshot.truncated ? " (Partial tool list)" : ""}
                    </p>
                  </details>
                </div>
              ))}
              {!record.instructions.length && (
                <p className="mt-2 text-muted-foreground">
                  Instruction capture unavailable for this turn.
                </p>
              )}
              <table className="mt-2 w-full table-fixed text-left">
                <caption className="sr-only">Turn {record.ordinal} context reads</caption>
                <thead>
                  <tr>
                    <th className="w-3/5">Read</th>
                    <th>Count</th>
                    <th>Bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {record.reads.map((read) => (
                    <tr
                      key={read.key}
                      className={
                        read.count > 1 || (read.outputBytes ?? 0) >= 32000
                          ? "text-warning-foreground"
                          : undefined
                      }
                    >
                      <td className="break-all py-1 pr-1">
                        {read.label}
                        <span className="block text-muted-foreground">
                          {read.kind} · {read.evidence}
                        </span>
                      </td>
                      <td>{read.count}</td>
                      <td>{number(read.outputBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="xs"
              disabled={beforeOrdinal === undefined}
              onClick={() => setBeforeOrdinal(undefined)}
            >
              Latest
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={query.data?.nextBeforeOrdinal == null}
              onClick={() => setBeforeOrdinal(query.data?.nextBeforeOrdinal ?? undefined)}
            >
              Older turns
            </Button>
          </div>
          <details className="space-y-2 text-muted-foreground">
            <summary className="cursor-pointer">How context is measured</summary>
            {query.data && <p>{query.data.coverage}</p>}
          </details>
        </div>
      </div>
    </div>
  );
}
