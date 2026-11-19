import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined ? { reason: "probeFailed" as const } : previous.unavailable;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(previous?.zeroSpendCap ? { zeroSpendCap: true } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    (a.modelIds === b.modelIds ||
      (a.modelIds !== undefined &&
        b.modelIds !== undefined &&
        a.modelIds.length === b.modelIds.length &&
        a.modelIds.every((id, index) => id === b.modelIds?.[index]))) &&
    (a.providerIds === b.providerIds ||
      (a.providerIds !== undefined &&
        b.providerIds !== undefined &&
        a.providerIds.length === b.providerIds.length &&
        a.providerIds.every((id, index) => id === b.providerIds?.[index]))) &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/** The sequence number of each published window's latest observation, by window id. */
export type UsageWindowSequences = ReadonlyMap<string, number>;

/**
 * Merges a probe into published limits window by window. Sequence numbers come from one
 * per-provider counter: a probe takes its number when it starts, a runtime update when applied.
 * A window observed after the probe started keeps its published value; the probe owns the rest.
 * A cached sample can refresh probe metadata without reapplying its windows.
 */
export function mergeProbedUsageLimits(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
  readonly sequences: UsageWindowSequences;
  readonly probeSequence: number;
  readonly cachedUsageSample?: boolean | undefined;
}): {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly sequences: UsageWindowSequences;
} {
  const { published, probed, sequences, probeSequence } = input;
  if (input.cachedUsageSample && published) {
    return {
      limits:
        !published.unavailable && probed && !probed.unavailable
          ? { ...probed, checkedAt: published.checkedAt, windows: published.windows }
          : published,
      sequences,
    };
  }
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return { limits: published, sequences };
  }
  const nextSequences = new Map(
    (probed?.windows ?? []).map((window) => [window.id, probeSequence] as const),
  );
  if (
    !published ||
    !probed ||
    published.unavailable?.reason === "unsupported" ||
    probed.unavailable?.reason === "unsupported"
  ) {
    return { limits: probed, sequences: nextSequences };
  }
  const newer = new Map<string, ServerProviderUsageWindow>();
  for (const window of published.windows) {
    const sequence = sequences.get(window.id);
    if (sequence !== undefined && sequence > probeSequence) {
      newer.set(window.id, window);
      nextSequences.set(window.id, sequence);
    }
  }
  if (newer.size === 0) {
    return { limits: probed, sequences: nextSequences };
  }
  const windows = probed.windows.map((window) => newer.get(window.id) ?? window);
  const probedIds = new Set(probed.windows.map((window) => window.id));
  for (const window of newer.values()) {
    if (!probedIds.has(window.id)) windows.push(window);
  }
  return {
    limits: { ...probed, checkedAt: published.checkedAt, windows: sortWindows(windows) },
    sequences: nextSequences,
  };
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
  }
  return probed;
}
