import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Case } from "./cases.ts";

export const TASK_NAMES = ["sed", "cite"] as const;
export type Task = (typeof TASK_NAMES)[number];

const Citation = Schema.Struct({
  file: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
});
const decodeCitation = Schema.decodeUnknownOption(Schema.fromJsonString(Citation));

const SED_ADDRESS = /sed\s+(?:-\S+\s+)*['"]?(\d+)(?:,(\d+))?/;

const samePath = (actual: string, expected: string) => actual.replace(/^\.\//, "") === expected;

function readTarget(
  task: Task,
  output: string,
): { file: string; start: number; end: number } | null {
  if (task === "cite") {
    const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
    return Option.match(decodeCitation(json), {
      onNone: () => null,
      onSome: (citation) => ({
        file: citation.file,
        start: citation.startLine,
        end: citation.endLine,
      }),
    });
  }
  const match = SED_ADDRESS.exec(output);
  if (!match) return null;
  const start = Number(match[1]);
  const command = output.slice(match.index).split("\n")[0] ?? "";
  const file =
    command
      .trim()
      .split(/\s+/)
      .at(-1)
      ?.replace(/^[`'"]+|[`'"]+$/g, "") ?? "";
  return { file, start, end: match[2] === undefined ? start : Number(match[2]) };
}

/** Passes when the reply names the commented file and exactly its lines. */
export const grade = (entry: Case, output: string, task: Task = "sed") => {
  const target = readTarget(task, output);
  if (!target) return { pass: false, reason: "no line address" };
  if (!samePath(target.file, entry.filePath))
    return { pass: false, reason: `named ${target.file || "no file"}` };
  if (target.start === entry.expectedStart && target.end === entry.expectedEnd)
    return { pass: true, reason: "right lines" };
  return { pass: false, reason: `acted on ${target.start}-${target.end}` };
};
