/** The row an arrow, Home or End key moves to; null for other keys or an empty list. */
export function compactListKeyTarget(
  key: string,
  ids: ReadonlyArray<string>,
  activeId: string | null,
): string | null {
  if (ids.length === 0) return null;
  const index = activeId === null ? -1 : ids.indexOf(activeId);
  switch (key) {
    case "ArrowDown":
      return ids[Math.min(index + 1, ids.length - 1)] ?? null;
    case "ArrowUp":
      return ids[index <= 0 ? 0 : index - 1] ?? null;
    case "Home":
      return ids[0] ?? null;
    case "End":
      return ids.at(-1) ?? null;
    default:
      return null;
  }
}
