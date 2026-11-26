import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, useContext } from "react";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface EnvironmentQueryView<A, E = unknown> {
  readonly data: A | null;
  readonly dataUpdatedAt: number;
  readonly error: string | null;
  readonly failure: E | null;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

export function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

function queryUpdatedAt(result: AsyncResult.AsyncResult<unknown, unknown>): number {
  return result._tag === "Success"
    ? result.timestamp
    : result._tag === "Failure"
      ? (Option.getOrNull(result.previousSuccess)?.timestamp ?? 0)
      : 0;
}

const DEFERRED_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(true)).pipe(
  Atom.withLabel("web-environment-query:deferred"),
);

/**
 * While true, queries below it start no request: each reads only what another reader already
 * holds, and otherwise reports pending. A host sets it while a selection is still changing.
 */
export const DeferEnvironmentQueries = createContext(false);

/** The atom to subscribe to, and while deferred, what another reader already holds for `atom`. */
function useQuerySource<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null) {
  const deferred = useContext(DeferEnvironmentQueries);
  const registry = useContext(RegistryContext);
  if (atom === null) return { subscribed: EMPTY_ASYNC_RESULT_ATOM, held: Option.none() };
  if (!deferred) return { subscribed: atom, held: Option.none() };
  // Peeking a node never mounts it, so nothing fetches or revalidates.
  const held = registry.getNodes().get(atom)?.valueOption() ?? Option.none();
  return {
    subscribed: DEFERRED_ASYNC_RESULT_ATOM,
    held: held as Option.Option<AsyncResult.AsyncResult<A, E>>,
  };
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A, E> {
  const source = useQuerySource(atom);
  const selectedAtom = source.subscribed;
  const live = useAtomValue(selectedAtom);
  const result = Option.getOrElse(source.held, () => live);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: AsyncResult.getOrElse(result, () => null),
    dataUpdatedAt: queryUpdatedAt(result),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    failure:
      result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null,
    isPending: atom !== null && result.waiting,
    isSuccess: result._tag === "Success",
    refresh,
  };
}

/** Keep select outside the component; a new function rebuilds the derived atom on every render. */
export function useEnvironmentQuerySelector<A, E, B>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  select: (result: AsyncResult.AsyncResult<A, E>) => B,
): B {
  const source = useQuerySource(atom);
  const live = useAtomValue(source.subscribed, select);
  return Option.match(source.held, { onNone: () => live, onSome: select });
}

type QueryResultAtom = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;
const queryIsNewerAtoms = new WeakMap<
  QueryResultAtom,
  WeakMap<QueryResultAtom, Atom.Atom<boolean>>
>();
function queryIsNewerAtom(query: QueryResultAtom, than: QueryResultAtom): Atom.Atom<boolean> {
  let byThan = queryIsNewerAtoms.get(query);
  if (byThan === undefined) {
    byThan = new WeakMap();
    queryIsNewerAtoms.set(query, byThan);
  }
  let atom = byThan.get(than);
  if (atom === undefined) {
    atom = Atom.make((get) => queryUpdatedAt(get(query)) >= queryUpdatedAt(get(than)));
    byThan.set(than, atom);
  }
  return atom;
}

export function useEnvironmentQueryIsNewer(
  query: QueryResultAtom | null,
  than: QueryResultAtom | null,
): boolean {
  return useAtomValue(
    queryIsNewerAtom(query ?? EMPTY_ASYNC_RESULT_ATOM, than ?? EMPTY_ASYNC_RESULT_ATOM),
  );
}

/** Returns refresh and call-time pending state without subscribing to it. */
export function useEnvironmentQueryRefresh<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): { readonly refresh: () => void; readonly isPending: () => boolean } {
  const registry = useContext(RegistryContext);
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const refresh = useAtomRefresh(selectedAtom);
  return { refresh, isPending: () => atom !== null && registry.get(selectedAtom).waiting };
}
