import type { EnvironmentId, StatusSource, StatusState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

export interface StatusStatePresentation {
  readonly label: string;
  readonly textClassName: string;
  readonly tintColorClassName: string;
  readonly symbol: AppSymbolName;
}

const STATE_PRESENTATION: Record<StatusState, StatusStatePresentation> = {
  ok: {
    label: "Passing",
    textClassName: "text-adaptive-emerald-700-300",
    tintColorClassName: "accent-adaptive-emerald-600-400",
    symbol: "checkmark.circle.fill",
  },
  warn: {
    label: "Warning",
    textClassName: "text-warning-foreground",
    tintColorClassName: "accent-warning-foreground",
    symbol: "exclamationmark.triangle",
  },
  fail: {
    label: "Failing",
    textClassName: "text-danger-foreground",
    tintColorClassName: "accent-danger-foreground",
    symbol: "xmark.circle.fill",
  },
  unknown: {
    label: "Not run",
    textClassName: "text-foreground-muted",
    tintColorClassName: "accent-foreground-muted",
    symbol: "clock",
  },
};

export function statusStatePresentation(state: StatusState): StatusStatePresentation {
  return STATE_PRESENTATION[state];
}

export type StatusEnvironmentResult =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly sources: ReadonlyArray<StatusSource> };

export function statusEnvironmentResult(
  result: AsyncResult.AsyncResult<ReadonlyArray<StatusSource>, unknown>,
): StatusEnvironmentResult {
  if (AsyncResult.isFailure(result)) {
    const error = Cause.squash(result.cause);
    return {
      kind: "failed",
      message: error instanceof Error && error.message ? error.message : "Could not load checks.",
    };
  }
  if (AsyncResult.isSuccess(result)) return { kind: "loaded", sources: result.value };
  return { kind: "loading" };
}

export interface StatusEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The server reports status sources and this client may read them. */
  readonly readable: boolean;
}

export interface StatusEnvironmentGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly result: StatusEnvironmentResult;
}

export type StatusScreenView =
  | { readonly kind: "no-environments" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "no-sources" }
  | {
      readonly kind: "groups";
      readonly showEnvironmentHeaders: boolean;
      readonly groups: ReadonlyArray<StatusEnvironmentGroup>;
    };

/**
 * What the Status page shows for the environments in the Settings scope. `results` holds one
 * entry per readable environment, in the same order.
 */
export function statusScreenView(
  environments: ReadonlyArray<StatusEnvironment>,
  results: ReadonlyArray<StatusEnvironmentResult>,
): StatusScreenView {
  if (environments.length === 0) return { kind: "no-environments" };
  const readable = environments.filter((environment) => environment.readable);
  if (readable.length === 0) return { kind: "unsupported" };
  const groups = readable.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    result: results[index] ?? { kind: "loading" as const },
  }));
  if (groups.every(({ result }) => result.kind === "loaded" && result.sources.length === 0)) {
    return { kind: "no-sources" };
  }
  return { kind: "groups", showEnvironmentHeaders: groups.length > 1, groups };
}

/**
 * When the source entered its current state, or null when the server has not seen it change
 * since it started.
 */
export function statusSourceHeldSince(
  source: Pick<StatusSource, "latest" | "lastTransition">,
): string | null {
  const transition = source.lastTransition;
  return transition && transition.to === source.latest.state ? transition.at : null;
}
