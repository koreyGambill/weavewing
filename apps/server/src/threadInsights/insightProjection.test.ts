import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_LOAD_WATCHERS,
  LoadWatchers,
  ServerSettings,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { projectLoadEvent } from "./insightProjection.ts";

const base = {
  id: TurnItemId.make("read"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-11-06T00:00:00Z"),
} as const;

const defaults = DEFAULT_LOAD_WATCHERS;
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const project = (item: OrchestrationV2TurnItem) => projectLoadEvent(item, defaults);

describe("load event projection", () => {
  it("distinguishes skill and instruction reads, search results, and inferred shell activity", () => {
    const read: OrchestrationV2TurnItem = {
      ...base,
      type: "dynamic_tool",
      toolName: "mcp__files__read_file",
      input: { path: "/repo/SKILL.md" },
      output: "abcé",
    };
    expect(project(read)).toMatchObject({
      kind: "skill",
      evidence: "reported",
      outputBytes: 5,
      estimatedOutputTokens: 2,
    });
    expect(
      project({ ...read, input: { file_path: "/repo/AGENTS.md" }, outputOmitted: true }),
    ).toMatchObject({ kind: "instructions", outputBytes: null });
    expect(
      project({
        ...base,
        type: "file_search",
        results: [{ fileName: "/repo/SKILL.md", line: 1, preview: "match" }],
      }),
    ).toMatchObject({ kind: "search", outputBytes: null });
    expect(
      project({
        ...base,
        type: "command_execution",
        input: "sed -n '1,20p' /repo/AGENTS.md",
        output: "instructions",
      }),
    ).toMatchObject({ kind: "instructions", evidence: "inferred", paths: ["/repo/AGENTS.md"] });
    for (const command of [
      "overwing search context engines",
      "overwing context --repo /repo",
      "overwing standards show standard-comments",
    ]) {
      expect(
        project({ ...base, type: "command_execution", input: command, output: "notes" }),
      ).toMatchObject({ kind: "knowledge", evidence: "inferred", label: `overwing: ${command}` });
    }
    for (const toolName of ["mcp__t3_code__list_read", "mcp__t3_code__artifact_read"]) {
      expect(
        project({
          ...read,
          toolName,
          input: { threadId: "other" },
        }),
      ).toMatchObject({ kind: "resource", label: `${toolName} other` });
    }
    expect(project({ ...read, toolName: "write_file" })).toBeNull();
    for (const [input, path] of [
      ["/usr/bin/zsh -lc 'cat /repo/AGENTS.md'", "/repo/AGENTS.md"],
      ['/bin/bash -lc "cat /repo/AGENTS.md"', "/repo/AGENTS.md"],
      ["/usr/bin/zsh -lc 'sed -n '\\''1,20p'\\'' /repo/AGENTS.md'", "/repo/AGENTS.md"],
      ['/bin/bash -c "cat \\"/repo/a b/AGENTS.md\\""', "/repo/a b/AGENTS.md"],
      ["cat AGENTS.md", "AGENTS.md"],
    ] as const) {
      expect(
        project({ ...base, type: "command_execution", input, output: "instructions" }),
      ).toMatchObject({
        kind: "instructions",
        evidence: "inferred",
        paths: [path],
      });
    }
    for (const [input, paths] of [
      ["git log | head -5", []],
      ["git log | tail -20", []],
      ["git log | grep release.md", []],
      ["cd /other/repo && cat README.md", ["README.md"]],
      ["cat README.md > /tmp/output.md", ["README.md"]],
      ["cat README.md >> /tmp/output.md", ["README.md"]],
      ["cat README.md 2> /tmp/errors.log", ["README.md"]],
      ["cat README.md\ncat AGENTS.md", ["README.md", "AGENTS.md"]],
      ["sed -i 's/a/b/' /repo/README.md", []],
      ["sed --in-place=.bak 's/a/b/' /repo/README.md", []],
      ["/usr/bin/cat README.md", ["README.md"]],
      ["head -5 README.md", ["README.md"]],
      ["rg 'release.md' README.md", ["README.md"]],
      ["cat README.md | head -5", ["README.md"]],
    ] as const) {
      const event = project({ ...base, type: "command_execution", input, output: "text" });
      if (paths.length) expect(event?.paths, input).toEqual(paths);
      else expect(event, input).toBeNull();
    }
    expect(
      project({
        ...base,
        type: "command_execution",
        input: "/usr/bin/zsh -lc 'cat /skills/review/SKILL.md /repo/MEMORY.md'",
        output: "No such file or directory",
        exitCode: 1,
      }),
    ).toMatchObject({
      kind: "skill",
      paths: ["/skills/review/SKILL.md", "/repo/MEMORY.md"],
      status: "failed",
    });
    expect(project({ ...read, toolName: "Skill", input: { skill: "code-review" } })).toMatchObject({
      kind: "skill",
      label: "code-review",
      paths: [],
    });
  });

  it("labels loads by the configured watcher, matching command words and tool name globs", () => {
    const watchers = [
      { label: "notes", kind: "command", match: "nb show" },
      { label: "vault", kind: "tool", match: "mcp__vault__*" },
      { label: "any read", kind: "tool", match: "mcp__*__read*" },
    ] as const;
    const command = { ...base, type: "command_execution", output: "text" } as const;
    const tool = (toolName: string) =>
      projectLoadEvent(
        {
          ...base,
          type: "dynamic_tool",
          toolName,
          input: { path: "/vault/AGENTS.md" },
          output: "card",
        },
        watchers,
      );
    for (const input of [
      "nb show standards",
      "/usr/local/bin/nb show x",
      "cd /repo && nb show x",
    ]) {
      expect(projectLoadEvent({ ...command, input }, watchers), input).toMatchObject({
        kind: "knowledge",
        label: `notes: ${input}`,
        paths: [],
      });
    }
    for (const input of ["nb shows x", "nb x show", "overwing search x"])
      expect(projectLoadEvent({ ...command, input }, watchers), input).toBeNull();
    expect(tool("mcp__vault__lookup")).toMatchObject({
      kind: "knowledge",
      label: "vault: mcp__vault__lookup",
      evidence: "reported",
    });
    expect(tool("mcp__files__read_file")).toMatchObject({
      label: "any read: mcp__files__read_file",
    });
    expect(tool("mcp__vault")).toBeNull();
    expect(projectLoadEvent({ ...command, input: "nb show x" }, [])).toBeNull();
  });

  it("refuses unusable watchers and falls back to defaults for an older stored format", () => {
    const decode = Schema.decodeUnknownExit(LoadWatchers);
    for (const watcher of [
      { label: "regex", kind: "command", pattern: "overwing\\s+search" },
      { label: "glob", kind: "tool", match: "mcp__(a|b)+$" },
      { label: "long", kind: "command", match: "a b c d e f g h i" },
    ])
      expect(decode([watcher])._tag, watcher.label).toBe("Failure");
    expect(decode(DEFAULT_LOAD_WATCHERS)._tag).toBe("Success");
    const stored = decodeServerSettings({
      loadWatchers: [{ label: "overwing", kind: "command", pattern: "overwing\\s+search" }],
    });
    expect(stored.loadWatchers).toEqual(DEFAULT_LOAD_WATCHERS);
  });
});
