import type { EnvironmentId, StatusItem, StatusSource, StatusState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { relativeTime } from "../../lib/time";

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

const DISABLED_PRESENTATION: StatusStatePresentation = {
  label: "Disabled",
  textClassName: "text-foreground-muted",
  tintColorClassName: "accent-foreground-muted",
  symbol: "circle.dashed",
};

/** Status payloads mark a check that is switched off as unknown with the detail "disabled". */
export function isStatusItemDisabled(item: Pick<StatusItem, "state" | "detail">): boolean {
  return item.state === "unknown" && item.detail?.trim().toLowerCase() === "disabled";
}

export function statusItemPresentation(
  item: Pick<StatusItem, "state" | "detail">,
): StatusStatePresentation {
  return isStatusItemDisabled(item) ? DISABLED_PRESENTATION : statusStatePresentation(item.state);
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
  /** The server reports status sources. */
  readonly supported: boolean;
  /** This client's session may read the server's status. */
  readonly permitted: boolean;
}

export function isStatusEnvironmentReadable(environment: StatusEnvironment): boolean {
  return environment.supported && environment.permitted;
}

export interface StatusEnvironmentGroup {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly result: StatusEnvironmentResult;
}

export type StatusScreenView =
  | { readonly kind: "no-environments" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "no-access" }
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
  const readable = environments.filter(isStatusEnvironmentReadable);
  if (readable.length === 0) {
    return environments.some((environment) => environment.supported)
      ? { kind: "no-access" }
      : { kind: "unsupported" };
  }
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
 * The source's state, with how long it has held when the server saw it change, such as
 * "Failing for 5m".
 */
export function statusSourceStateText(
  source: Pick<StatusSource, "latest" | "lastTransition">,
  nowMs: number,
): string {
  const label = statusStatePresentation(source.latest.state).label;
  const transition = source.lastTransition;
  return transition && transition.to === source.latest.state
    ? `${label} for ${relativeTime(transition.at, nowMs)}`
    : label;
}
