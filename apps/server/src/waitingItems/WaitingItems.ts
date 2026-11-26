import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as EvidenceService from "../evidence/EvidenceService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadWorkspace from "../threadWorkspace/ThreadWorkspace.ts";

/**
 * Mirrors each thread's questions, QA changes and user tasks onto the thread, so the thread list
 * and the strip above the composer need no reads of their stores. Every rebuild reads all three
 * stores whole, so a mirror never outlives the items it shows.
 */
export class WaitingItems extends Context.Service<
  WaitingItems,
  {
    /** Rebuilds one thread's mirror from its three stores. */
    readonly rebuild: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Rebuilds every thread with a waiting item in a store or in its mirror, archived threads
     * included, so a rebuild lost to a crash heals without a visit. Returns threads rebuilt.
     */
    readonly reconcile: Effect.Effect<number>;
    /** Rebuilds each thread whose stores change. Runs until interrupted. */
    readonly follow: Effect.Effect<void>;
  }
>()("t3/waitingItems/WaitingItems") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadWorkspace = yield* ThreadWorkspace.ThreadWorkspace;
  const evidence = yield* EvidenceService.EvidenceService;
  const random = yield* SecureRandom.SecureRandom;
  // One rebuild at a time, so an older read never overwrites a newer one.
  const lock = yield* Semaphore.make(1);

  const rebuild = Effect.fn("WaitingItems.rebuild")(
    function* (threadId: ThreadId) {
      const [mine, qa] = yield* Effect.all(
        [threadWorkspace.waitingItems(threadId), evidence.waitingQa(threadId)],
        { concurrency: 2 },
      );
      yield* orchestrator.dispatch({
        type: "thread.waiting.sync",
        commandId: CommandId.make(`waiting-sync:${yield* random.uuidV4()}`),
        threadId,
        // The orchestrator drops a sync that changes nothing.
        items: [...mine, ...qa],
      });
    },
    lock.withPermit,
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not mirror a thread's waiting items; the next change retries.", {
        cause,
      }),
    ),
  );

  const reconcile = Effect.gen(function* () {
    const [stored, qa, snapshot] = yield* Effect.all(
      [
        threadWorkspace.waitingThreads,
        evidence.waitingQaThreads(),
        orchestrator.getShellSnapshot(),
      ],
      { concurrency: 3 },
    );
    const shells = [...snapshot.threads, ...snapshot.archivedThreads];
    const mirrored = shells.filter((thread) => (thread.waiting?.length ?? 0) > 0);
    const activity = new Map(
      shells.map((thread) => [thread.id, DateTime.toEpochMillis(thread.updatedAt)] as const),
    );
    // The threads people are most likely looking at come first; each rebuild waits on file and
    // database reads, so requests run between them.
    const threadIds = [...new Set<ThreadId>([...stored, ...qa, ...mirrored.map((t) => t.id)])].sort(
      (a, b) => (activity.get(b) ?? -1) - (activity.get(a) ?? -1),
    );
    for (const threadId of threadIds) yield* rebuild(threadId);
    return threadIds.length;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not list threads to mirror waiting items for.", { cause }).pipe(
        Effect.as(0),
      ),
    ),
    Effect.withSpan("WaitingItems.reconcile"),
  );

  const follow = Stream.merge(threadWorkspace.changes, evidence.qaThreadChanges).pipe(
    Stream.runForEach(rebuild),
    Effect.withSpan("WaitingItems.follow"),
  );

  return WaitingItems.of({ rebuild, reconcile, follow });
});

export const layer = Layer.effect(WaitingItems, make);
