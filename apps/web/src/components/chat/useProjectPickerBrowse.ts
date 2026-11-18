import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, FilesystemBrowseResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { useContext, useEffect, useState } from "react";

import { filesystemEnvironment } from "~/state/filesystem";

const homeDirectories = new WeakMap<object, Map<EnvironmentId, string>>();

const EMPTY_LISTINGS: ReadonlyArray<BrowseListing> = [];

interface BrowseTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
}

interface BrowseListing {
  readonly environmentId: EnvironmentId;
  readonly result: FilesystemBrowseResult | null;
  readonly error: string | null;
}

export function useProjectPickerBrowse(
  targets: ReadonlyArray<BrowseTarget>,
  partialPath: string | null,
  open: boolean,
) {
  const registry = useContext(RegistryContext);
  const [response, setResponse] = useState<{
    readonly requestKey: string;
    readonly listings: ReadonlyArray<BrowseListing>;
  } | null>(null);
  const requestKey = JSON.stringify({ targets, partialPath, open });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to debounced filesystem queries and aborts their Effect fibers when the query or destination changes
  useEffect(() => {
    const { targets, partialPath, open } = JSON.parse(requestKey) as {
      targets: ReadonlyArray<BrowseTarget>;
      partialPath: string | null;
      open: boolean;
    };
    if (!open || !partialPath || targets.length === 0) return;
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      const program = Effect.forEach(
        targets,
        (target) =>
          AtomRegistry.getResult(
            registry,
            filesystemEnvironment.browse({
              environmentId: target.environmentId,
              input: { partialPath, ...(target.cwd ? { cwd: target.cwd } : {}) },
            }),
            { suspendOnWaiting: true },
          ).pipe(
            Effect.match({
              onSuccess: (result): BrowseListing => ({
                environmentId: target.environmentId,
                result,
                error: null,
              }),
              onFailure: (error): BrowseListing => ({
                environmentId: target.environmentId,
                result: null,
                error: error instanceof Error ? error.message : "Could not browse this folder.",
              }),
            }),
          ),
        { concurrency: 3 },
      );
      void Effect.runPromise(program, { signal: abort.signal })
        .then((listings) => {
          if (abort.signal.aborted) return;
          if (partialPath === "~/") {
            const homes = new Map(homeDirectories.get(registry));
            for (const listing of listings) {
              if (listing.result) homes.set(listing.environmentId, listing.result.parentPath);
            }
            homeDirectories.set(registry, homes);
          }
          setResponse({ requestKey, listings });
        })
        .catch((cause: unknown) => {
          if (abort.signal.aborted) return;
          setResponse({
            requestKey,
            listings: targets.map((target) => ({
              environmentId: target.environmentId,
              result: null,
              error: cause instanceof Error ? cause.message : "Could not browse this folder.",
            })),
          });
        });
    }, 180);
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [registry, requestKey]);

  return {
    listings: response?.requestKey === requestKey ? response.listings : EMPTY_LISTINGS,
    pending:
      open && partialPath !== null && targets.length > 0 && response?.requestKey !== requestKey,
  };
}

export function useProjectPickerHomes(targets: ReadonlyArray<BrowseTarget>, open: boolean) {
  const registry = useContext(RegistryContext);
  const [homes, setHomes] = useState<ReadonlyMap<EnvironmentId, string>>(
    () => homeDirectories.get(registry) ?? new Map(),
  );
  const missing = targets.filter((target) => !homes.has(target.environmentId));
  const response = useProjectPickerBrowse(missing, "~/", open);
  const resolved = response.listings.filter(
    (listing) => listing.result && !homes.has(listing.environmentId),
  );
  if (resolved.length > 0) {
    const next = new Map(homes);
    for (const listing of resolved) {
      if (listing.result) next.set(listing.environmentId, listing.result.parentPath);
    }
    setHomes(next);
  }
  return homes;
}
