import { describe, expect, it } from "vite-plus/test";

import {
  conversationFileLinks,
  formatFileLinkRange,
  selectLinkableMessages,
  type LinkableMessage,
} from "./conversationFileLinks";

const cwd = "/repo";
const reply = (text: string): LinkableMessage => ({ type: "assistant_message", text });

describe("conversationFileLinks", () => {
  it("lists each resolved file once, most recently linked first, with its cited ranges", () => {
    const links = conversationFileLinks(
      [
        reply("See [panel](apps/web/Panel.tsx:57-64) and [store](/repo/src/store.ts#L10)."),
        reply("Also `src/store.ts:3` and [again](./apps/web/Panel.tsx:57-64)."),
        reply("Finally [panel](/repo/apps/web/Panel.tsx:12) and [docs](docs/a.md)."),
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
      [reply("[a](src/a.ts:5) [b](src/a.ts:5-9) [c](src/a.ts#L5)")],
      cwd,
    );
    expect(link?.ranges).toEqual([{ line: 5 }, { line: 5, endLine: 9 }]);
  });

  it("ignores web links, links inside code blocks and messages without file links", () => {
    expect(
      conversationFileLinks(
        [
          reply("Read https://example.com and [site](https://example.com/a.ts)."),
          reply("```md\n[fenced](src/fenced.ts:1) `src/fenced.ts:2`\n```"),
          reply(""),
        ],
        cwd,
      ),
    ).toEqual([]);
  });

  it("treats Windows spellings of one file as one entry and opens the latest spelling", () => {
    const links = conversationFileLinks(
      [reply("[a](src/a.ts:5)"), reply("[b](C:/repo/SRC/a.ts:7)")],
      "C:/repo",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.ranges.map(formatFileLinkRange)).toEqual(["5", "7"]);
    expect(links[0]?.panelPath).toBe("SRC/a.ts");
  });

  it("keeps POSIX paths that differ only in case apart", () => {
    expect(conversationFileLinks([reply("[a](src/a.ts) [b](src/A.ts)")], cwd)).toHaveLength(2);
  });

  it("re-resolves a cached message when the workspace changes", () => {
    const messages = [reply("[a](src/a.ts:1)")];
    expect(conversationFileLinks(messages, "/one")[0]?.filePath).toBe("/one/src/a.ts");
    expect(conversationFileLinks(messages, "/two")[0]?.filePath).toBe("/two/src/a.ts");
  });
});

describe("selectLinkableMessages", () => {
  const user = { item: { type: "user_message", text: "[a](src/a.ts)" } };
  const done = { item: { type: "assistant_message", text: "[b](src/b.ts)", streaming: false } };
  const reasoning = (text: string) => ({ item: { type: "reasoning", text, streaming: true } });
  const select = (
    items: ReadonlyArray<{ item: unknown }>,
    previous: ReadonlyArray<LinkableMessage>,
  ) => selectLinkableMessages(items as Parameters<typeof selectLinkableMessages>[0], previous);

  it("keeps the same list, and so the same files, while only reasoning streams", () => {
    const first = select([user, done, reasoning("Thinking")], []);
    const second = select([user, done, reasoning("Thinking harder")], first);
    expect(second).toBe(first);
    expect(conversationFileLinks(second, cwd)).toBe(conversationFileLinks(first, cwd));
  });

  it("leaves a streaming reply out until it finishes", () => {
    const streaming = { item: { ...done.item, text: "[c](src/c.ts)", streaming: true } };
    const first = select([user, streaming], []);
    expect(first).toEqual([user.item]);
    const finished = select([user, { item: { ...streaming.item, streaming: false } }], first);
    expect(finished).not.toBe(first);
    expect(finished.map((message) => message.text)).toEqual(["[a](src/a.ts)", "[c](src/c.ts)"]);
  });
});
