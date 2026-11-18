import type { StatusItem, StatusPayload, StatusState } from "@t3tools/contracts";

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

export type SourceExpansion = { expanded: boolean; state: StatusState };

export function sourceExpansionState(payload: Pick<StatusPayload, "state" | "items">) {
  return [payload.state, ...payload.items.map((item) => item.state)].reduce((worst, state) =>
    stateOrder[state] < stateOrder[worst] ? state : worst,
  );
}

export function sourceExpanded(
  payload: Pick<StatusPayload, "state" | "items">,
  saved: SourceExpansion | null,
) {
  if (!saved) return sourceDefaultExpanded(payload);
  return (
    saved.expanded ||
    (sourceDefaultExpanded(payload) &&
      stateOrder[sourceExpansionState(payload)] < stateOrder[saved.state])
  );
}
