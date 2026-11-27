import {
  DevelopmentEnvironmentCheckoutUnavailableError,
  XwingEnvironmentId,
  type XwingOperationError,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- hold keys are pure digests cleanup recomputes.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as XwingOperations from "../xwing/XwingOperations.ts";

const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The Xwing hold owner for every binding this T3 server makes. Other servers are foreign. */
export const holdOwner = (environmentId: string) =>
  `t3-server-${digest(environmentId).slice(0, 32)}`;

const threadKeyPrefix = (threadId: string) => `thread-${digest(threadId).slice(0, 32)}-binding-`;

/**
 * One immutable key per binding period: the thread and the command that bound it. A later binding
 * of the same thread gets its own key, so releasing an older period never drops a newer one.
 * Thread ids are hashed because delegated ids exceed Xwing's key syntax.
 */
export const holdKey = (binding: { readonly threadId: string; readonly period: string }) =>
  `${threadKeyPrefix(binding.threadId)}${digest(binding.period).slice(0, 16)}`;

/** The thread among `threadIds` that a hold key of this server names, if any. */
export const holdThread = <Id extends string>(
  key: string,
  threadIds: ReadonlyArray<Id>,
): Id | null => threadIds.find((threadId) => key.startsWith(threadKeyPrefix(threadId))) ?? null;

const holdLabel = (title: string) =>
  `T3 Code: ${title.replace(/\p{Cc}+/gu, " ").trim()}`.slice(0, 200);

export interface DevelopmentEnvironmentHoldBinding {
  readonly xwingEnvironmentId: string;
  readonly threadId: string;
  /** The command that binds, so a replay maps to the same key. */
  readonly period: string;
  readonly title: string;
}

/**
 * Owns this server's Xwing holds and serializes binding against cleanup per environment. Bindings
 * commit inside `retain`; cleanup runs inside `exclusive`, so a cleanup never releases a hold
 * whose binding is still committing.
 */
export class DevelopmentEnvironmentHolds extends Context.Service<
  DevelopmentEnvironmentHolds,
  {
    readonly owner: Effect.Effect<string>;
    /**
     * Registers the binding's hold, then runs `commit`. If `commit` fails, releases the hold only
     * when this call created it, so a replayed binding keeps its earlier hold. `keepOnFailure`
     * is for commits whose failure does not prove nothing was bound.
     */
    readonly retain: <A, E, R>(
      binding: DevelopmentEnvironmentHoldBinding,
      commit: Effect.Effect<A, E, R>,
      options?: { readonly keepOnFailure?: boolean },
    ) => Effect.Effect<A, E | DevelopmentEnvironmentCheckoutUnavailableError, R>;
    readonly exclusive: <A, E, R>(
      xwingEnvironmentId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /**
     * Releases every hold this server owns on the environment for `threadId`, whichever binding
     * registered it. Releasing holds already gone succeeds, and so does an unreachable Xwing:
     * environment cleanup can still release what remains.
     */
    readonly releaseThread: (input: {
      readonly xwingEnvironmentId: XwingEnvironmentId;
      readonly threadId: string;
    }) => Effect.Effect<void, XwingOperationError>;
  }
>()("t3/developmentEnvironments/DevelopmentEnvironmentHolds") {}

const decodeXwingEnvironmentId = Schema.decodeUnknownOption(XwingEnvironmentId);

const make = Effect.gen(function* () {
  const operations = yield* XwingOperations.XwingOperations;
  const identity = yield* ServerEnvironmentIdentity;
  const locks = yield* KeyedLock.make<string>();
  const owner = Effect.map(identity.getEnvironmentId, holdOwner);

  const retain: DevelopmentEnvironmentHolds["Service"]["retain"] = (binding, commit, options) =>
    locks.withLock(
      binding.xwingEnvironmentId,
      Effect.gen(function* () {
        const unavailable = new DevelopmentEnvironmentCheckoutUnavailableError({
          xwingEnvironmentId: binding.xwingEnvironmentId,
          reason: "hold-unavailable",
        });
        const id = decodeXwingEnvironmentId(binding.xwingEnvironmentId);
        if (Option.isNone(id)) return yield* unavailable;
        const environmentId = yield* identity.getEnvironmentId;
        const hold = {
          id: id.value,
          owner: holdOwner(environmentId),
          key: holdKey(binding),
        };
        const registered = yield* operations
          .registerHold({
            ...hold,
            label: holdLabel(binding.title),
            detail: `T3 server ${environmentId}; thread ${binding.threadId}`,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Xwing did not register a development environment hold", cause),
            ),
            Effect.mapError(() => unavailable),
          );
        const exit = yield* Effect.exit(commit);
        if (Exit.isFailure(exit) && registered.result === "created" && !options?.keepOnFailure) {
          yield* operations.releaseHold(hold).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Xwing did not release an uncommitted binding's hold", cause),
            ),
            Effect.ignore,
          );
        }
        return yield* exit;
      }),
    );

  const releaseThread: DevelopmentEnvironmentHolds["Service"]["releaseThread"] = Effect.fn(
    "DevelopmentEnvironmentHolds.releaseThread",
  )(
    function* ({ xwingEnvironmentId: id, threadId }) {
      const ownHolds = yield* owner;
      yield* locks.withLock(
        id,
        Effect.gen(function* () {
          const held = yield* operations.listHolds({ id, owner: ownHolds });
          for (const hold of held) {
            if (holdThread(hold.key, [threadId]) === null) continue;
            yield* operations.releaseHold({ id, owner: ownHolds, key: hold.key });
          }
        }),
      );
    },
    Effect.catchTags({
      XwingUnavailableError: (cause) =>
        Effect.logWarning("Xwing was unavailable to release a thread's holds", cause),
    }),
  );

  return DevelopmentEnvironmentHolds.of({
    owner,
    retain,
    exclusive: locks.withLock,
    releaseThread,
  });
});

export const layer = Layer.effect(DevelopmentEnvironmentHolds, make);
