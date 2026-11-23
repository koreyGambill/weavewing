interface LineGeometry {
  readonly top: number;
  readonly height: number;
}

interface CenteredFileLineScrollInput {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly fileTop: number;
  readonly estimatedLine: LineGeometry;
  readonly renderedLine?: LineGeometry;
}

export function resolveCenteredFileLineScrollTop(input: CenteredFileLineScrollInput): number {
  const lineTop =
    input.renderedLine === undefined
      ? input.fileTop + input.estimatedLine.top
      : input.scrollTop + input.renderedLine.top - input.viewportTop;
  const lineHeight = input.renderedLine?.height ?? input.estimatedLine.height;
  const centeredTop = Math.max(0, lineTop - Math.max(0, (input.viewportHeight - lineHeight) / 2));
  return Math.min(centeredTop, Math.max(0, input.scrollHeight - input.viewportHeight));
}

export interface FileLineRange {
  readonly start: number;
  readonly end: number;
}

function countFileLines(contents: string): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return lineCount;
}

/** The lines a link names, clamped to the file; a missing or inverted end selects one line. */
export function resolveFileLineRange(
  contents: string,
  line: number,
  endLine: number | null,
): FileLineRange {
  const lineCount = countFileLines(contents);
  const start = Math.min(Math.max(1, line), lineCount);
  const end = endLine === null ? start : Math.min(Math.max(start, endLine), lineCount);
  return { start, end };
}

/** One box spanning the first and last line, so a range centers as a block. */
export function spanLineGeometry(first: LineGeometry, last: LineGeometry): LineGeometry {
  return { top: first.top, height: Math.max(first.height, last.top + last.height - first.top) };
}
