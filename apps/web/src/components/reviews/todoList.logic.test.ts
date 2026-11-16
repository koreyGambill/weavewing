import type { ListItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { todoIndentMove, todoTabUpdate, todoTree, type TodoNode } from "./todoList.logic";

const item = (
  id: string,
  options: Partial<Pick<ListItem, "owner" | "state" | "parentId">> = {},
): ListItem => ({
  id,
  text: id,
  state: options.state ?? "open",
  owner: options.owner ?? "agent",
  createdAt: "2026-11-13T00:00:00.000Z",
  doneAt: null,
  details: "",
  parentId: options.parentId ?? null,
  links: [],
});

const shape = (nodes: ReadonlyArray<TodoNode>): unknown[] =>
  nodes.map((node) => [
    node.item.id,
    ...(node.context ? ["context"] : []),
    ...(node.children.length ? [shape(node.children)] : []),
  ]);

describe("todoTree", () => {
  const items = [
    item("plan", { owner: "you" }),
    item("build", { parentId: "plan" }),
    item("review", { owner: "you", parentId: "build" }),
    item("ship", { state: "done", owner: "you" }),
    item("orphan", { parentId: "missing" }),
  ];

  it("nests children in list order and hides closed items until asked", () => {
    expect(shape(todoTree(items, { filter: "all", showClosed: false }))).toEqual([
      ["plan", [["build", [["review"]]]]],
      ["orphan"],
    ]);
    expect(
      todoTree(items, { filter: "all", showClosed: true }).map((node) => node.item.id),
    ).toEqual(["plan", "ship", "orphan"]);
  });

  it("keeps a filtered-out parent as context for a matching child", () => {
    expect(shape(todoTree(items, { filter: "mine", showClosed: false }))).toEqual([
      ["plan", [["build", "context", [["review"]]]]],
    ]);
    expect(shape(todoTree(items, { filter: "agents", showClosed: false }))).toEqual([
      ["plan", "context", [["build"]]],
      ["orphan"],
    ]);
  });

  it("counts progress over every descendant", () => {
    const done = [
      item("a"),
      item("b", { parentId: "a", state: "done" }),
      item("c", { parentId: "a" }),
    ];
    expect(todoTree(done, { filter: "all", showClosed: false })[0]?.progress).toEqual({
      done: 1,
      total: 2,
    });
  });
});

describe("todoIndentMove", () => {
  const items = [
    item("a"),
    item("b"),
    item("b1", { parentId: "b" }),
    item("b2", { parentId: "b" }),
    item("b2x", { parentId: "b2" }),
    item("c"),
  ];
  const all = new Set(items.map((entry) => entry.id));

  it("indents last under the previous sibling and outdents just below the old parent", () => {
    expect(todoIndentMove(items, "c", "in", all)).toEqual({
      parentId: "b",
      order: ["a", "b", "b1", "b2", "c", "b2x"],
    });
    expect(todoIndentMove(items, "b1", "out", all)).toEqual({
      parentId: null,
      order: ["a", "b", "b1", "b2", "b2x", "c"],
    });
    expect(todoIndentMove(items, "b2x", "out", all)?.parentId).toBe("b");
  });

  it("indents under the previous visible sibling, skipping ones the filter hides", () => {
    const visible = new Set(["a", "c"]);
    expect(todoIndentMove(items, "c", "in", visible)?.parentId).toBe("a");
  });

  it("refuses moves without a target or past the nesting limit", () => {
    expect(todoIndentMove(items, "a", "in", all)).toBeUndefined();
    expect(todoIndentMove(items, "a", "out", all)).toBeUndefined();
    expect(todoIndentMove(items, "b1", "in", all)).toBeUndefined();
    // Either move would put b2x on a fourth level.
    expect(todoIndentMove(items, "b2", "in", all)).toBeUndefined();
    expect(todoIndentMove(items, "b", "in", all)).toBeUndefined();
  });

  it("Tab after editing writes the new text and parent in one change", () => {
    expect(todoTabUpdate(items, "c", " renamed ", "in", all)).toEqual({
      changes: [{ id: "c", parentId: "b", text: "renamed" }],
      order: ["a", "b", "b1", "b2", "c", "b2x"],
    });
    expect(todoTabUpdate(items, "c", "c", "in", all)?.changes).toEqual([
      { id: "c", parentId: "b" },
    ]);
    expect(todoTabUpdate(items, "a", "renamed", "in", all)).toBeUndefined();
  });
});
