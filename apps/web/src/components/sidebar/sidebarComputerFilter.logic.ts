export interface SidebarComputerServer {
  readonly environmentId: string;
  readonly label: string;
  /** The computer the server runs on, when its config names one. */
  readonly computer: string | null;
}

/** Servers under their computer, in first-seen order; servers on an unknown computer come last. */
export function groupSidebarComputers<T extends SidebarComputerServer>(
  servers: readonly T[],
): Array<{ computer: string | null; servers: T[] }> {
  const byComputer = new Map<string | null, T[]>();
  for (const server of servers) {
    const list = byComputer.get(server.computer) ?? [];
    list.push(server);
    byComputer.set(server.computer, list);
  }
  const groups = [...byComputer.entries()].map(([computer, list]) => ({ computer, servers: list }));
  return [
    ...groups.filter((group) => group.computer !== null),
    ...groups.filter((group) => group.computer === null),
  ];
}

/**
 * The servers the sidebar shows, or null for every server. Once the server list has loaded, a
 * chosen server that no longer exists drops out, and a filter left with none reads as every server.
 */
export function resolveSidebarComputerScope(input: {
  readonly storedIds: readonly string[];
  readonly knownIds: readonly string[];
  readonly ready: boolean;
}): ReadonlySet<string> | null {
  const known = new Set(input.knownIds);
  const chosen = input.ready ? input.storedIds.filter((id) => known.has(id)) : input.storedIds;
  return chosen.length === 0 ? null : new Set(chosen);
}

/**
 * The stored choice without servers the loaded catalog no longer has, or null when nothing needs
 * dropping. A saved server that is offline stays in the catalog, so it stays chosen.
 */
export function pruneSidebarComputerScope(input: {
  readonly storedIds: readonly string[];
  readonly knownIds: readonly string[];
  readonly ready: boolean;
}): string[] | null {
  if (!input.ready) return null;
  const known = new Set(input.knownIds);
  const kept = input.storedIds.filter((id) => known.has(id));
  return kept.length === input.storedIds.length ? null : kept;
}

/** Whether a thread passes the computer filter; the open thread always does. */
export function isSidebarComputerThreadShown(
  thread: { readonly environmentId: string; readonly id: string },
  scope: ReadonlySet<string> | null,
  openThreadKey: string | null,
): boolean {
  return (
    scope === null ||
    scope.has(thread.environmentId) ||
    `${thread.environmentId}:${thread.id}` === openThreadKey
  );
}

export function toggleSidebarComputerScope(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}
