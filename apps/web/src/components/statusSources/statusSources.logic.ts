import type { StatusItem, StatusPayload, StatusSource, StatusState } from "@t3tools/contracts";

const stateOrder: Record<StatusState, number> = { fail: 0, warn: 1, ok: 2, unknown: 3 };

export function isStatusItemDisabled(item: StatusItem) {
  return item.state === "unknown" && item.detail?.trim().toLowerCase() === "disabled";
}

export function groupStatusItems(items: ReadonlyArray<StatusItem>) {
  const sorted = [...items].sort((a, b) => stateOrder[a.state] - stateOrder[b.state]);
  return {
    active: sorted.filter((item) => !isStatusItemDisabled(item)),
    inactive: sorted.filter(isStatusItemDisabled),
  };
}

export function sourceDefaultExpanded(payload: Pick<StatusPayload, "state" | "items">) {
  return [payload.state, ...payload.items.map((item) => item.state)].some(
    (state) => state === "fail" || state === "warn",
  );
}

export function statusItemCounts(items: ReadonlyArray<StatusItem>) {
  const counts = (["fail", "warn", "ok", "unknown"] as const).map((state) => {
    const count = items.filter(
      (item) => item.state === state && !isStatusItemDisabled(item),
    ).length;
    return count ? `${count} ${state === "unknown" ? "not run" : state}` : "";
  });
  const disabled = items.filter(isStatusItemDisabled).length;
  return [...counts, disabled ? `${disabled} off` : ""].filter(Boolean).join(" · ");
}

export type SourceExpansion = { expanded: boolean; state: StatusState; at?: string };

export function sourceExpansionState(payload: Pick<StatusPayload, "state" | "items">) {
  return [payload.state, ...payload.items.map((item) => item.state)].reduce((worst, state) =>
    stateOrder[state] < stateOrder[worst] ? state : worst,
  );
}

/** A collapse holds until the source is worse than when collapsed or has transitioned since. */
export function sourceExpanded(
  payload: Pick<StatusPayload, "state" | "items">,
  saved: SourceExpansion | null,
  lastTransitionAt?: string,
) {
  if (!saved) return sourceDefaultExpanded(payload);
  if (saved.expanded) return true;
  if (!sourceDefaultExpanded(payload)) return false;
  return (
    stateOrder[sourceExpansionState(payload)] < stateOrder[saved.state] ||
    (saved.at !== undefined && lastTransitionAt !== undefined && lastTransitionAt > saved.at)
  );
}

/**
 * Keeps one copy of each check across the environments a client shows: the
 * environment's own source when it is shown, otherwise the first mirror of it.
 */
export function withoutRepeatedMirrors(
  groups: ReadonlyArray<ReadonlyArray<StatusSource> | null>,
  shown: ReadonlySet<string>,
): ReadonlyArray<ReadonlyArray<StatusSource> | null> {
  const seen = new Set<string>();
  return groups.map((sources) => {
    if (!sources) return sources;
    const kept = sources.filter((source) => {
      if (!source.origin) return true;
      if (shown.has(source.origin.environmentId) || seen.has(source.config.id)) return false;
      seen.add(source.config.id);
      return true;
    });
    return kept.length === sources.length ? sources : kept;
  });
}
