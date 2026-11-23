import type { Case } from "./cases.ts";

const ADDRESS: Record<string, RegExp> = {
  sed: /sed\s+(?:-\S+\s+)*['"]?(\d+)(?:,(\d+))?/,
  cite: /"startLine"\s*:\s*(\d+)[\s\S]*?"endLine"\s*:\s*(\d+)/,
};

/** Passes when the reply's first line address (a `sed` address or a JSON citation) names the commented file lines. */
export const grade = (entry: Case, output: string, task = "sed") => {
  const match = ADDRESS[task]?.exec(output);
  if (!match) return { pass: false, reason: "no line address" };
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start === entry.expectedStart && end === entry.expectedEnd)
    return { pass: true, reason: "right lines" };
  return { pass: false, reason: `acted on ${start}-${end}` };
};
