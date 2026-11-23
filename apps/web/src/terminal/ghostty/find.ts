export interface TerminalFindMatch {
  /** Screen row, counted from the oldest scrollback row. */
  readonly row: number;
  /** UTF-16 offsets into the row's text; `end` is exclusive. */
  readonly start: number;
  readonly end: number;
}

/** Case-insensitive, non-overlapping literal matches, in screen order. A match never spans rows. */
export function findTerminalMatches(lines: readonly string[], query: string): TerminalFindMatch[] {
  if (query.length === 0) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
  const matches: TerminalFindMatch[] = [];
  lines.forEach((line, row) => {
    for (const match of line.matchAll(pattern)) {
      matches.push({ row, start: match.index, end: match.index + match[0].length });
    }
  });
  return matches;
}

/** The first match at or below the viewport's top row, else the last match; -1 when none. */
export function initialTerminalMatchIndex(
  matches: readonly TerminalFindMatch[],
  viewportTop: number,
): number {
  const index = matches.findIndex((match) => match.row >= viewportTop);
  return index >= 0 ? index : matches.length - 1;
}

export function stepTerminalMatchIndex(count: number, index: number, forward: boolean): number {
  if (count === 0) return -1;
  if (index < 0) return forward ? 0 : count - 1;
  return (index + (forward ? 1 : -1) + count) % count;
}
