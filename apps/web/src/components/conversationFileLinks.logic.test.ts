import { describe, expect, it } from "vite-plus/test";

import { conversationFileLinks, formatFileLinkRange } from "./conversationFileLinks.logic";

const cwd = "/repo";

describe("conversationFileLinks", () => {
  it("lists each resolved file once, most recently linked first, with its cited ranges", () => {
    const links = conversationFileLinks(
      [
        { text: "See [panel](apps/web/Panel.tsx:57-64) and [store](/repo/src/store.ts#L10)." },
        { text: "Also `src/store.ts:3` and [again](./apps/web/Panel.tsx:57-64)." },
        { text: "Finally [panel](/repo/apps/web/Panel.tsx:12) and [docs](docs/a.md)." },
      ],
      cwd,
    );

    expect(links.map((link) => [link.panelPath, link.ranges.map(formatFileLinkRange)])).toEqual([
      ["apps/web/Panel.tsx", ["12", "57-64"]],
      ["docs/a.md", []],
      ["src/store.ts", ["3", "10"]],
    ]);
    expect(links[0]).toMatchObject({ filePath: "/repo/apps/web/Panel.tsx", basename: "Panel.tsx" });
  });

  it("keeps a single line and a range starting on it as separate citations", () => {
    const [link] = conversationFileLinks(
      [{ text: "[a](src/a.ts:5) [b](src/a.ts:5-9) [c](src/a.ts#L5)" }],
      cwd,
    );
    expect(link?.ranges).toEqual([{ line: 5 }, { line: 5, endLine: 9 }]);
  });

  it("ignores web links and messages without file links", () => {
    expect(
      conversationFileLinks(
        [{ text: "Read https://example.com and [site](https://example.com/a.ts)." }, { text: "" }],
        cwd,
      ),
    ).toEqual([]);
  });

  it("re-resolves a cached message when the workspace changes", () => {
    const message = { text: "[a](src/a.ts:1)" };
    expect(conversationFileLinks([message], "/one")[0]?.filePath).toBe("/one/src/a.ts");
    expect(conversationFileLinks([message], "/two")[0]?.filePath).toBe("/two/src/a.ts");
  });
});
