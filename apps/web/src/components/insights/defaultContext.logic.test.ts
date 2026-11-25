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
    item({
      label: "/home/me/.claude/CLAUDE.md",
      category: "files",
      estimatedTokens: 8_500,
      repository: false,
    }),
    // Above the nested working folder below, yet inside the repository the server resolved.
    item({
      label: "/home/me/repo/AGENTS.md",
      category: "files",
      estimatedTokens: 9_000,
      repository: true,
    }),
    item({
      label: "/home/me/repo/app/x.md",
      category: "files",
      estimatedTokens: 700,
      repository: true,
    }),
    item({ label: "skill", category: "skills", estimatedTokens: 4_400 }),
    item({ label: "deferred", category: "tools", estimatedTokens: 5_000, counted: false }),
  ];
  const known = 24_600;
  const withFirstTurn = (promptTokens: number | null) => ({
    ...preview(items),
    cwd: "/home/me/repo/app",
    firstTurn:
      promptTokens === null ? null : { promptTokens, reportedAt: "2026-11-25T00:00:00.000Z" },
  });
  const rows = (result: ReturnType<typeof usedContextSources>) =>
    result?.reconciles ? result.sources.map((source) => [source.key, source.tokens]) : null;
  const total = (result: ReturnType<typeof usedContextSources>) =>
    result?.reconciles ? result.sources.reduce((sum, source) => sum + source.tokens, 0) : null;

  it("groups instruction files by the server's repository flag and splits off the first turn", () => {
    const result = usedContextSources(withFirstTurn(70_000), 163_000);
    expect(rows(result)).toEqual([
      ["conversation", 93_000],
      ["harness", 70_000 - known],
      ["repository-files", 9_700],
      ["global-files", 8_500],
      ["skills", 4_400],
      ["t3", 2_000],
    ]);
    expect(total(result)).toBe(163_000);
  });

  it("keeps instruction files in one row when the server sends no repository flag", () => {
    const unflagged = items.map(({ repository: _repository, ...rest }) => rest);
    const result = usedContextSources({ ...preview(unflagged), firstTurn: null }, 70_000);
    expect(rows(result)).toContainEqual(["files", 18_200]);
  });

  it("folds the conversation into one remainder without a first-turn report", () => {
    const result = usedContextSources(withFirstTurn(null), 70_000);
    expect(rows(result)?.at(0)).toEqual(["rest", 70_000 - known]);
    expect(total(result)).toBe(70_000);
  });

  it("ignores a first-turn report larger than current use, as after compaction", () => {
    const result = usedContextSources(withFirstTurn(100_000), 30_000);
    expect(rows(result)).toContainEqual(["rest", 30_000 - known]);
    expect(total(result)).toBe(30_000);
  });

  it("ignores a first-turn report smaller than the itemized estimates", () => {
    const result = usedContextSources(withFirstTurn(10_000), 30_000);
    expect(rows(result)?.some(([key]) => key === "harness")).toBe(false);
    expect(total(result)).toBe(30_000);
  });

  it("reports estimates that exceed the provider's count instead of rows", () => {
    expect(usedContextSources(withFirstTurn(10_000), 5_000)).toEqual({
      reconciles: false,
      knownTokens: known,
      usedTokens: 5_000,
    });
  });

  it("returns null when the provider's default context is unsupported", () => {
    expect(usedContextSources({ ...preview(items), support: "unsupported" }, 1)).toBeNull();
  });
});
