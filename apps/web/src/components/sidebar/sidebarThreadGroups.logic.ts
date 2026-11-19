import * as Schema from "effect/Schema";

/**
 * The user's own groups of active threads, keyed by scoped thread key so a group can span
 * projects and servers. Threads missing from `ungroupedOrder` sit at the top of Ungrouped
 * in recency order, so a new thread never lands inside a group or below the manual order.
 */
export const SidebarThreadGroups = Schema.Struct({
  groups: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      collapsed: Schema.Boolean,
      threadKeys: Schema.Array(Schema.String),
    }),
  ),
  ungroupedOrder: Schema.Array(Schema.String),
  ungroupedCollapsed: Schema.Boolean,
});
export type SidebarThreadGroups = typeof SidebarThreadGroups.Type;
export type SidebarThreadGroup = SidebarThreadGroups["groups"][number];

export const EMPTY_SIDEBAR_THREAD_GROUPS: SidebarThreadGroups = {
  groups: [],
  ungroupedOrder: [],
  ungroupedCollapsed: false,
};

/** A thread with its visible forks; the head key places the whole family. */
type Family = readonly string[];

export interface SidebarThreadGroupArrangement {
  readonly groups: ReadonlyArray<{
    readonly group: SidebarThreadGroup;
    readonly families: Family[];
  }>;
  readonly ungrouped: Family[];
}

/** `groupId` null is Ungrouped; `beforeKey` null is the end of the container. */
export interface SidebarGroupDropTarget {
  readonly groupId: string | null;
  readonly beforeKey: string | null;
}

export type SidebarGroupHit =
  | { readonly kind: "header"; readonly groupId: string | null }
  | { readonly kind: "thread"; readonly key: string; readonly after: boolean };

/** Lays out active thread families, given in recency order, into the user's groups. */
export function arrangeSidebarThreadGroups(
  state: SidebarThreadGroups,
  families: ReadonlyArray<Family>,
  // `keepGroupId` names a group the user is naming, which stays shown even when empty.
  options: { readonly hideEmptyGroups: boolean; readonly keepGroupId?: string | null },
): SidebarThreadGroupArrangement {
  const familyByHead = new Map(families.map((family) => [family[0]!, family]));
  const grouped = new Set<string>();
  const groups = state.groups.map((group) => {
    const members: Family[] = [];
    for (const key of group.threadKeys) {
      const family = familyByHead.get(key);
      if (family === undefined || grouped.has(key)) continue;
      grouped.add(key);
      members.push(family);
    }
    return { group, families: members };
  });
  const manualRank = new Map(state.ungroupedOrder.map((key, index) => [key, index]));
  const fresh: Family[] = [];
  const ranked: Family[] = [];
  for (const family of families) {
    const head = family[0]!;
    if (grouped.has(head)) continue;
    (manualRank.has(head) ? ranked : fresh).push(family);
  }
  ranked.sort((left, right) => manualRank.get(left[0]!)! - manualRank.get(right[0]!)!);
  return {
    groups: options.hideEmptyGroups
      ? groups.filter(
          (group) => group.families.length > 0 || group.group.id === options.keepGroupId,
        )
      : groups,
    ungrouped: [...fresh, ...ranked],
  };
}

function containerFamilies(
  arrangement: SidebarThreadGroupArrangement,
  groupId: string | null,
): Family[] | undefined {
  return groupId === null
    ? arrangement.ungrouped
    : arrangement.groups.find((entry) => entry.group.id === groupId)?.families;
}

function locate(arrangement: SidebarThreadGroupArrangement, key: string) {
  const containers: Array<[string | null, Family[]]> = [
    ...arrangement.groups.map((entry) => [entry.group.id, entry.families] as [string, Family[]]),
    [null, arrangement.ungrouped],
  ];
  for (const [groupId, families] of containers) {
    const index = families.findIndex((family) => family.includes(key));
    if (index !== -1) return { groupId, families, index, isHead: families[index]![0] === key };
  }
  return null;
}

/** Where a dragged thread lands for a pointer hit, or null when nothing would change. */
export function resolveSidebarGroupDrop(
  arrangement: SidebarThreadGroupArrangement,
  draggedKey: string,
  hit: SidebarGroupHit,
): SidebarGroupDropTarget | null {
  const source = locate(arrangement, draggedKey);
  if (source === null || !source.isHead) return null;
  const headsWithout = (families: readonly Family[]) =>
    families.map((family) => family[0]!).filter((key) => key !== draggedKey);
  let target: SidebarGroupDropTarget;
  if (hit.kind === "header") {
    const families = containerFamilies(arrangement, hit.groupId);
    if (families === undefined) return null;
    target = { groupId: hit.groupId, beforeKey: headsWithout(families)[0] ?? null };
  } else {
    const over = locate(arrangement, hit.key);
    if (over === null) return null;
    const head = over.families[over.index]![0]!;
    if (head === draggedKey) return null;
    // A fork row sits inside its family, so dropping there means after the family.
    const after = hit.after || !over.isHead;
    const heads = headsWithout(over.families);
    const beforeKey = after ? (heads[heads.indexOf(head) + 1] ?? null) : head;
    target = { groupId: over.groupId, beforeKey };
  }
  const currentNext = source.families[source.index + 1]?.[0] ?? null;
  return target.groupId === source.groupId && target.beforeKey === currentNext ? null : target;
}

/** Moves a thread into a group or Ungrouped at a position. */
export function placeSidebarThread(
  state: SidebarThreadGroups,
  arrangement: SidebarThreadGroupArrangement,
  key: string,
  target: SidebarGroupDropTarget,
): SidebarThreadGroups {
  if (target.groupId !== null && !state.groups.some((group) => group.id === target.groupId)) {
    return state;
  }
  const insert = (keys: readonly string[]) => {
    const next = keys.filter((candidate) => candidate !== key);
    const at = target.beforeKey === null ? -1 : next.indexOf(target.beforeKey);
    next.splice(at === -1 ? next.length : at, 0, key);
    return next;
  };
  const groups = state.groups.map((group) => {
    if (group.id === target.groupId) return { ...group, threadKeys: insert(group.threadKeys) };
    return group.threadKeys.includes(key)
      ? { ...group, threadKeys: group.threadKeys.filter((candidate) => candidate !== key) }
      : group;
  });
  if (target.groupId !== null) {
    return {
      ...state,
      groups,
      ungroupedOrder: state.ungroupedOrder.filter((candidate) => candidate !== key),
    };
  }
  // Shown threads take the new order in the slots shown threads held, so threads a filter or
  // a shelf hides keep their places.
  const shownBefore = arrangement.ungrouped.map((family) => family[0]!);
  const stored = new Set(state.ungroupedOrder);
  const order = [...shownBefore.filter((entry) => !stored.has(entry)), ...state.ungroupedOrder];
  if (!order.includes(key)) {
    const at = target.beforeKey === null ? -1 : order.indexOf(target.beforeKey);
    order.splice(at === -1 ? order.length : at, 0, key);
  }
  const shown = insert(shownBefore);
  const shownSet = new Set(shown);
  let next = 0;
  return {
    ...state,
    groups,
    ungroupedOrder: order.map((entry) => (shownSet.has(entry) ? shown[next++]! : entry)),
  };
}

/** Moves a thread one place up or down within its container; null at either end. */
export function stepSidebarThread(
  state: SidebarThreadGroups,
  arrangement: SidebarThreadGroupArrangement,
  key: string,
  delta: -1 | 1,
): SidebarThreadGroups | null {
  const source = locate(arrangement, key);
  if (source === null || !source.isHead) return null;
  const neighbor = source.families[source.index + delta];
  if (neighbor === undefined) return null;
  const beforeKey = delta === -1 ? neighbor[0]! : (source.families[source.index + 2]?.[0] ?? null);
  return placeSidebarThread(state, arrangement, key, { groupId: source.groupId, beforeKey });
}

/** The group a thread belongs to, or null for Ungrouped. */
export function sidebarThreadGroupOf(state: SidebarThreadGroups, key: string): string | null {
  return state.groups.find((group) => group.threadKeys.includes(key))?.id ?? null;
}

export function addSidebarThreadGroup(
  state: SidebarThreadGroups,
  input: { readonly id: string; readonly name: string; readonly threadKey?: string },
): SidebarThreadGroups {
  const { threadKey } = input;
  const without = (keys: readonly string[]) =>
    threadKey === undefined ? keys : keys.filter((key) => key !== threadKey);
  return {
    ...state,
    groups: [
      ...state.groups.map((group) =>
        threadKey !== undefined && group.threadKeys.includes(threadKey)
          ? { ...group, threadKeys: without(group.threadKeys) }
          : group,
      ),
      {
        id: input.id,
        name: input.name,
        collapsed: false,
        threadKeys: threadKey === undefined ? [] : [threadKey],
      },
    ],
    ungroupedOrder: without(state.ungroupedOrder),
  };
}

/** The name a new group starts with; leaving it, or nothing, means the group was never named. */
export const NEW_SIDEBAR_THREAD_GROUP_NAME = "New group";

export function isUnnamedSidebarThreadGroup(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "" || trimmed === NEW_SIDEBAR_THREAD_GROUP_NAME;
}

/**
 * Drops a group that was never named and puts any thread moved into it back where `previous`,
 * the state before the group was made, had it. Other changes made meanwhile stay.
 */
export function discardNewSidebarThreadGroup(
  state: SidebarThreadGroups,
  previous: SidebarThreadGroups,
  id: string,
): SidebarThreadGroups {
  const moved = state.groups.find((group) => group.id === id)?.threadKeys ?? [];
  const remaining = deleteSidebarThreadGroup(state, id);
  const keysByGroup = new Map(remaining.groups.map((group) => [group.id, [...group.threadKeys]]));
  const ungrouped = [...remaining.ungroupedOrder];
  const insertAt = (keys: string[], index: number, key: string) => {
    const at = keys.indexOf(key);
    if (at !== -1) keys.splice(at, 1);
    keys.splice(Math.min(index, keys.length), 0, key);
  };
  for (const key of moved) {
    const from = previous.groups.find((group) => group.threadKeys.includes(key));
    const fromKeys = from === undefined ? undefined : keysByGroup.get(from.id);
    if (from !== undefined && fromKeys !== undefined) {
      insertAt(fromKeys, from.threadKeys.indexOf(key), key);
      continue;
    }
    const index = previous.ungroupedOrder.indexOf(key);
    if (index !== -1) insertAt(ungrouped, index, key);
  }
  return {
    ...remaining,
    groups: remaining.groups.map((group) => ({
      ...group,
      threadKeys: keysByGroup.get(group.id) ?? group.threadKeys,
    })),
    ungroupedOrder: ungrouped,
  };
}

export function renameSidebarThreadGroup(
  state: SidebarThreadGroups,
  id: string,
  name: string,
): SidebarThreadGroups {
  const trimmed = name.trim();
  if (trimmed.length === 0) return state;
  return {
    ...state,
    groups: state.groups.map((group) => (group.id === id ? { ...group, name: trimmed } : group)),
  };
}

export function deleteSidebarThreadGroup(
  state: SidebarThreadGroups,
  id: string,
): SidebarThreadGroups {
  return { ...state, groups: state.groups.filter((group) => group.id !== id) };
}

/** Toggles a group's collapse; null toggles Ungrouped. */
export function toggleSidebarThreadGroup(
  state: SidebarThreadGroups,
  id: string | null,
): SidebarThreadGroups {
  if (id === null) return { ...state, ungroupedCollapsed: !state.ungroupedCollapsed };
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === id ? { ...group, collapsed: !group.collapsed } : group,
    ),
  };
}

export function moveSidebarThreadGroup(
  state: SidebarThreadGroups,
  id: string,
  delta: -1 | 1,
): SidebarThreadGroups {
  const index = state.groups.findIndex((group) => group.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= state.groups.length) return state;
  const groups = [...state.groups];
  [groups[index], groups[target]] = [groups[target]!, groups[index]!];
  return { ...state, groups };
}

export type SidebarGroupHitRow =
  | {
      readonly kind: "header" | "end";
      readonly groupId: string | null;
      readonly top: number;
      readonly bottom: number;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly top: number;
      readonly bottom: number;
    };

// Lets a drop just under the last row still land at the end of Ungrouped.
const END_SLACK_PX = 8;

/** Maps a pointer's y to a header or the near half of a row, given rows in document order. */
export function resolveSidebarGroupHit(
  rows: readonly SidebarGroupHitRow[],
  y: number,
): SidebarGroupHit | null {
  const first = rows[0];
  const last = rows.at(-1);
  if (first === undefined || last === undefined) return null;
  if (y < first.top || y > last.bottom + END_SLACK_PX) return null;
  let hit: SidebarGroupHitRow | undefined;
  for (const row of rows) {
    if (row.kind === "end") continue;
    if (row.top > y) break;
    hit = row;
  }
  if (hit === undefined) return null;
  if (hit.kind === "thread") {
    return { kind: "thread", key: hit.key, after: y >= (hit.top + hit.bottom) / 2 };
  }
  return { kind: "header", groupId: hit.groupId };
}

export interface SidebarShelfHit {
  readonly section: "pinned" | "settled";
  /** The list item the drop lands on, as dnd-kit's `over` would name it. */
  readonly overId: string;
}

// Lets a drop just above the Settled header, in the gap below the last group, still settle.
const SHELF_SLACK_PX = 4;

/**
 * The Pinned or Settled drop for a pointer outside the groups: above the first group is
 * Pinned, at a pinned row or else at the top; from the Settled header down is Settled.
 */
export function resolveSidebarShelfHit(input: {
  readonly y: number;
  readonly listTop: number;
  readonly firstGroupTop: number;
  readonly pinnedRows: ReadonlyArray<{
    readonly key: string;
    readonly top: number;
    readonly bottom: number;
  }>;
  readonly pinnedHeaderId: string;
  readonly settledTop: number | null;
  readonly settledHeaderId: string;
}): SidebarShelfHit | null {
  const { y } = input;
  if (y >= input.listTop - SHELF_SLACK_PX && y < input.firstGroupTop) {
    const row = input.pinnedRows.find((candidate) => y >= candidate.top && y < candidate.bottom);
    return { section: "pinned", overId: row?.key ?? input.pinnedHeaderId };
  }
  if (input.settledTop !== null && y >= input.settledTop - SHELF_SLACK_PX) {
    return { section: "settled", overId: input.settledHeaderId };
  }
  return null;
}
