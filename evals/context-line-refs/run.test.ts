import { describe, expect, it } from "vite-plus/test";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

const single = cases.find((entry) => entry.id === "file-single-line")!;
const range = cases.find((entry) => entry.id === "file-range")!;

describe("grade a citation", () => {
  it.each([
    ["exact", single, '{"file": "src/config.ts", "startLine": 20, "endLine": 20}', true],
    ["reordered keys", single, '{"endLine": 20, "file": "src/config.ts", "startLine": 20}', true],
    [
      "fenced",
      range,
      '```json\n{"file": "docs/setup.md", "startLine": 19, "endLine": 24}\n```',
      true,
    ],
    [
      "relative prefix",
      single,
      '{"file": "./src/config.ts", "startLine": 20, "endLine": 20}',
      true,
    ],
    [
      "zero-based index",
      single,
      '{"file": "src/config.ts", "startLine": 19, "endLine": 19}',
      false,
    ],
    ["wrong file", single, '{"file": "src/retry.ts", "startLine": 20, "endLine": 20}', false],
    ["range end off", range, '{"file": "docs/setup.md", "startLine": 19, "endLine": 23}', false],
    ["not JSON", single, "Line 20 of src/config.ts", false],
  ] as const)("%s", (_name, entry, output, pass) => {
    expect(grade(entry, output).pass).toBe(pass);
  });
});
