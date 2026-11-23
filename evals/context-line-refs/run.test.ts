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
  ] as const)("%s", (_name, entry, output, pass) => {
    expect(grade(entry, output).pass).toBe(pass);
  });
});
