import { describe, expect, it } from "vite-plus/test";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

const single = cases.find((entry) => entry.id === "file-single-line")!;
const range = cases.find((entry) => entry.id === "file-range")!;

describe("grade a sed command", () => {
  it.each([
    ["one-based line", single, "sed -i '20s/10_000/30_000/' src/config.ts", true],
    ["zero-based index", single, "sed -i '19s/10_000/30_000/' src/config.ts", false],
    ["double quotes", single, 'sed -i "20s/10_000/30_000/" src/config.ts', true],
    ["fenced", single, "```sh\nsed -i '20s/10_000/30_000/' src/config.ts\n```", true],
    ["range", range, "sed -i '19,24d' docs/setup.md", true],
    ["range off by one", range, "sed -i '18,23d' docs/setup.md", false],
    ["pattern address", single, "sed -i 's/10_000/30_000/' src/config.ts", false],
    ["wrong file", single, "sed -i '20s/10_000/30_000/' src/retry.ts", false],
    ["inline code", single, "`sed -i '20s/10_000/30_000/' src/config.ts`", true],
  ] as const)("%s", (_name, entry, output, pass) => {
    expect(grade(entry, output, "sed").pass).toBe(pass);
  });
});

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
    expect(grade(entry, output, "cite").pass).toBe(pass);
  });
});
