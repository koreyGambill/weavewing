import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, FilesystemBrowseResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import { useContext, useEffect, useState } from "react";

import { filesystemEnvironment } from "~/state/filesystem";

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
          if (!abort.signal.aborted) setResponse({ requestKey, listings });
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
  }, [registry, requestKey, targets, partialPath, open]);

  return {
    listings: response?.requestKey === requestKey ? response.listings : EMPTY_LISTINGS,
    pending:
      open && partialPath !== null && targets.length > 0 && response?.requestKey !== requestKey,
  };
}
