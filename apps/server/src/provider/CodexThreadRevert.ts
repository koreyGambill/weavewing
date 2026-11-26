import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

/**
 * Reverts up to `numTurns` of the thread's latest turns, stopping at the first turn `removable`
 * rejects, and reports how many it reverted.
 */
export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  numTurns: number,
  removable: (turnId: string) => boolean = () => true,
) {
  let remaining = numTurns;
  let reverted = 0;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (remaining > 0) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: Math.min(remaining, 100),
      sortDirection: "desc",
      itemsView: "summary",
    });
    let stopped = false;
    for (const turn of page.data) {
      if (!removable(turn.id)) {
        stopped = true;
        break;
      }
      beforeTurnId = turn.id;
      reverted += 1;
      if (--remaining === 0) break;
    }
    cursor = page.nextCursor ?? null;
    if (stopped || cursor === null) break;
  }
  const response =
    beforeTurnId === undefined
      ? yield* client.request("thread/read", { threadId, includeTurns: false })
      : yield* client.request("thread/revert", { threadId, beforeTurnId });
  return { response, reverted };
});
