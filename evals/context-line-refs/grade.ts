import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Case } from "./cases.ts";

const Citation = Schema.Struct({
  file: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
});
const decodeCitation = Schema.decodeUnknownOption(Schema.fromJsonString(Citation));

/** Passes when the reply's JSON citation names the commented file and exactly its lines. */
export const grade = (entry: Case, output: string) => {
  const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  return Option.match(decodeCitation(json), {
    onNone: () => ({ pass: false, reason: "no citation" }),
    onSome: (citation) => {
      if (citation.file.replace(/^\.\//, "") !== entry.filePath)
        return { pass: false, reason: `named ${citation.file}` };
      if (citation.startLine === entry.expectedStart && citation.endLine === entry.expectedEnd)
        return { pass: true, reason: "right lines" };
      return { pass: false, reason: `cited ${citation.startLine}-${citation.endLine}` };
    },
  });
};
