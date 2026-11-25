import type { DefaultContextItem, DefaultContextPreview } from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultContextSummary,
  fileTree,
  homeOf,
  shortenPath,
  splitPath,
  usedContextSources,
} from "./defaultContext.logic";

const item = (overrides: Partial<DefaultContextItem>): DefaultContextItem => ({
  id: overrides.label ?? "x",
  category: "t3",
  label: "x",
  source: "test",
  delivery: "every-turn",
  bytes: 0,
  estimatedTokens: 0,
  counted: true,
  readable: true,
  ...overrides,
});

const preview = (
  items: ReadonlyArray<DefaultContextItem>,
  lastTurn?: { readonly injectedBytes: number },
): DefaultContextPreview => ({
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  driver: "claudeAgent",
  model: "opus",
  cwd: null,
  support: "exact",
  filesSupported: true,
  notes: [],
  items,
  notVisible: [],
  lastTurn:
    lastTurn === undefined
      ? null
      : { capturedAt: "2026-11-13T00:00:00.000Z", model: "opus", reportsFiles: true, ...lastTurn },
  estimateMethod: "",
});

describe("defaultContextSummary", () => {
  it("totals only counted items and orders categories and groups", () => {
    const summary = defaultContextSummary(
      preview(
        [
          item({ label: "tool", category: "tools", bytes: 400, estimatedTokens: 100 }),
          item({
            label: "deferred",
            category: "tools",
            bytes: 4000,
            estimatedTokens: 1000,
            counted: false,
          }),
          item({
            label: "CLAUDE.md",
            category: "files",
            bytes: 400,
            estimatedTokens: 100,
            status: "not-loaded",
          }),
          item({ label: "runtime", bytes: 800, estimatedTokens: 200 }),
          item({ label: "AGENTS.md", category: "files", bytes: 9, status: "unexpected" }),
          item({ label: "append", category: "custom", bytes: 9, counted: false }),
          item({ label: "tdd", category: "skills", bytes: 40, estimatedTokens: 10 }),
        ],
        { injectedBytes: 800 },
      ),
    );
    expect(summary).toMatchObject({
      bytes: 1649,
      tokens: 410,
      attention: 2,
      injectedDiff: 9,
    });
    expect(summary.categories.map((category) => [category.category, category.share])).toEqual([
      ["t3", 800 / 1649],
      ["files", 409 / 1649],
      ["skills", 40 / 1649],
      ["tools", 400 / 1649],
    ]);
    expect(summary.groups.map((group) => [group.category, group.items.length])).toEqual([
      ["t3", 1],
      ["files", 2],
      ["skills", 1],
      ["tools", 2],
      ["custom", 1],
    ]);
  });
});

describe("fileTree", () => {
  it("nests linked files under their parent and keeps orphans visible", () => {
    const { roots, childrenOf } = fileTree([
      item({ label: "CLAUDE.md" }),
      item({ label: "a.md", parentId: "CLAUDE.md" }),
      item({ label: "b.md", parentId: "a.md" }),
      item({ label: "orphan.md", parentId: "gone.md" }),
    ]);
    expect(roots.map((entry) => entry.label)).toEqual(["CLAUDE.md", "orphan.md"]);
    expect(childrenOf.get("CLAUDE.md")?.map((entry) => entry.label)).toEqual(["a.md"]);
    expect(childrenOf.get("a.md")?.map((entry) => entry.label)).toEqual(["b.md"]);
  });
});

describe("paths", () => {
  it("collapses the home folder only on a whole path segment", () => {
    const home = homeOf(["/srv/x", "/home/korey/code/AGENTS.md"]);
    expect(home).toBe("/home/korey");
    expect(shortenPath("/home/korey/.claude/CLAUDE.md", home)).toBe("~/.claude/CLAUDE.md");
    expect(shortenPath("/home/koreyx/CLAUDE.md", home)).toBe("/home/koreyx/CLAUDE.md");
    expect(shortenPath("/etc/claude-code/CLAUDE.md", null)).toBe("/etc/claude-code/CLAUDE.md");
    expect(splitPath("~/.config/wing/AGENT_BOOTSTRAP.md")).toEqual({
      directory: "~/.config/wing/",
      name: "AGENT_BOOTSTRAP.md",
    });
  });
});

describe("usedContextSources", () => {
  const items = [
    item({ label: "t3 part", category: "t3", estimatedTokens: 2_000 }),
    item({ label: "/home/me/.claude/CLAUDE.md", category: "files", estimatedTokens: 8_500 }),
    item({ label: "/home/me/repo/AGENTS.md", category: "files", estimatedTokens: 9_000 }),
    item({ label: "/home/me/repo/docs/x.md", category: "files", estimatedTokens: 700 }),
    item({ label: "skill", category: "skills", estimatedTokens: 4_400 }),
    item({ label: "deferred", category: "tools", estimatedTokens: 5_000, counted: false }),
  ];
  const withCwd = (firstTurn: DefaultContextPreview["firstTurn"]) => ({
    ...preview(items),
    cwd: "/home/me/repo",
    firstTurn,
  });

  it("splits instruction files by folder and infers the harness from the first prompt", () => {
    const result = usedContextSources(
      withCwd({ promptTokens: 70_000, reportedAt: "2026-11-25T00:00:00.000Z" }),
      163_000,
    );
    expect(result?.sources.map((source) => [source.key, source.tokens])).toEqual([
      ["conversation", 93_000],
      ["harness", 45_400],
      ["repository-files", 9_700],
      ["global-files", 8_500],
      ["skills", 4_400],
      ["t3", 2_000],
    ]);
    expect(result?.sources[2]?.items.map((entry) => entry.label)).toEqual([
      "/home/me/repo/AGENTS.md",
      "/home/me/repo/docs/x.md",
    ]);
  });

  it("folds the conversation into one remainder without a first-turn report", () => {
    const result = usedContextSources(withCwd(null), 70_000);
    expect(result?.sources.at(0)).toMatchObject({ key: "rest", tokens: 45_400 });
    expect(result?.sources.some((source) => source.key === "harness")).toBe(false);
  });

  it("never reports negative remainders when estimates exceed the report", () => {
    const result = usedContextSources(
      withCwd({ promptTokens: 10_000, reportedAt: "2026-11-25T00:00:00.000Z" }),
      5_000,
    );
    const derived = result?.sources.filter((source) => source.items.length === 0);
    expect(derived?.map((source) => source.tokens)).toEqual([0, 0]);
  });

  it("returns null when the provider's default context is unsupported", () => {
    expect(usedContextSources({ ...preview(items), support: "unsupported" }, 1)).toBeNull();
  });
});
