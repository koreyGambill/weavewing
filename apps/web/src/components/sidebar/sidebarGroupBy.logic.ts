import * as Schema from "effect/Schema";

/** How the sidebar sections its active threads. Pinned, Snoozed and Settled never change. */
export const SidebarGroupBy = Schema.Literals([
  "named",
  "project",
  "computer",
  "provider",
  "model",
]);
export type SidebarGroupBy = typeof SidebarGroupBy.Type;

export const SIDEBAR_GROUP_BY_LABEL: Record<SidebarGroupBy, string> = {
  named: "Named groups",
  project: "Project",
  computer: "Computer",
  provider: "Provider",
  model: "Model",
};

export interface SidebarDerivedSection<T> {
  readonly key: string;
  readonly label: string;
  readonly items: T[];
}

/**
 * Sections thread families by a key read from each family's head, so a fork stays under the
 * thread it came from. Sections and the families in them keep the order given.
 */
export function sectionSidebarFamilies<T>(
  families: ReadonlyArray<readonly T[]>,
  sectionOf: (head: T) => { readonly key: string; readonly label: string },
): SidebarDerivedSection<T>[] {
  const sections = new Map<string, SidebarDerivedSection<T>>();
  for (const family of families) {
    const head = family[0];
    if (head === undefined) continue;
    const { key, label } = sectionOf(head);
    let section = sections.get(key);
    if (section === undefined) {
      section = { key, label, items: [] };
      sections.set(key, section);
    }
    section.items.push(...family);
  }
  return [...sections.values()];
}
