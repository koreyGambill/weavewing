// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type InstructionFootprint,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as McpToolCatalog from "../mcp/McpToolCatalog.ts";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  claudePreparedContextEntries,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { SkillSources } from "../agentContext/SkillSources.ts";
import { DefaultContext, layer as defaultContextLayer, startingPrompt } from "./DefaultContext.ts";
import { t3ContextParts } from "./defaultContextParts.ts";
import { InstructionFootprints } from "./InstructionFootprints.ts";
import {
  FILE_CONVENTIONS,
  fileStatus,
  importReferences,
  markdownLinks,
  MAX_READ_BYTES,
  readBounded,
  reconcileFiles,
  resolveInstructionFiles,
} from "./instructionFiles.ts";

const parts = (driver: string, deviceTools: boolean, hasT3Mcp = true) =>
  t3ContextParts({
    driver,
    model: "gpt-5.4",
    interactionMode: "default",
    hasT3Mcp,
    browserTools: true,
    deviceTools,
  });

it("renders Claude's append with the adapter's own query options", () => {
  for (const deviceTools of [false, true]) {
    for (const hasT3Mcp of [false, true]) {
      const { systemPrompt } = makeClaudeQueryOptions({
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
        nativeThreadId: "preview",
        resume: false,
        cwd: null,
        deviceToolsAvailable: deviceTools,
        ...(hasT3Mcp
          ? { mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } } }
          : {}),
      });
      const append =
        typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
      expect(parts("claudeAgent", deviceTools, hasT3Mcp).groups[0]?.entries).toEqual(
        claudePreparedContextEntries(append ?? ""),
      );
    }
  }
});

it.effect("renders Codex additionalContext with the adapter's own turn parameters", () =>
  Effect.gen(function* () {
    for (const deviceTools of [false, true]) {
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "preview",
        codexInput: [{ type: "text", text: "hi" }],
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        hasT3Mcp: true,
        browserToolsAvailable: true,
        deviceToolsAvailable: deviceTools,
      });
      expect(parts("codex", deviceTools).groups[0]?.entries).toEqual(
        Object.entries(params.additionalContext ?? {}).map(([key, entry]) => ({
          key,
          text: entry.value,
        })),
      );
    }
  }),
);

it("marks drivers without a known injection path unsupported", () => {
  expect(parts("ollama", false)).toEqual({ support: "unsupported", groups: [] });
  expect(parts("kiro", false).groups[0]?.delivery).toBe("first-prompt");
});

it.effect(
  "reads a checkout T3 keeps under its home, while secret folders inside it stay blocked",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }),
      );
      const home = path.join(base, "home");
      const checkout = path.join(home, ".t3", "worktrees", "project", "feature");
      yield* write(fs, path.join(checkout, ".git"), "gitdir: elsewhere");
      yield* write(fs, path.join(checkout, "CLAUDE.md"), "@.ssh/keys.md");
      yield* write(fs, path.join(checkout, ".ssh", "keys.md"), "secret");
      const dirs = {
        home,
        platform: "linux" as const,
        configDir: path.join(home, ".claude"),
        worktreesDir: path.join(home, ".t3", "worktrees"),
      };
      const { files } = yield* resolveInstructionFiles(
        FILE_CONVENTIONS.claudeAgent!,
        checkout,
        dirs,
        notInternal,
      );
      expect(files.map((file) => [path.relative(checkout, file.path), file.status])).toEqual([
        ["CLAUDE.md", "expected"],
        [".ssh/keys.md", "secret"],
      ]);

      // Any other project inside a credential folder keeps that folder's protection.
      const kube = path.join(home, ".kube");
      yield* write(fs, path.join(kube, "CLAUDE.md"), "@config");
      yield* write(fs, path.join(kube, "config"), "token");
      const kubeFiles = yield* resolveInstructionFiles(
        FILE_CONVENTIONS.claudeAgent!,
        kube,
        dirs,
        notInternal,
      );
      expect(kubeFiles.files.map((file) => [path.relative(kube, file.path), file.status])).toEqual([
        ["CLAUDE.md", "secret"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it("finds @ imports outside code and ignores fenced or inline ones", () => {
  expect(
    importReferences(
      "See @./a.md and @~/b.md.\nmail dev@example.com\n`@skip.md`\n```\n@fenced.md\n```\n@docs/c.md @/abs.md @...",
    ),
  ).toEqual(["./a.md", "~/b.md", "docs/c.md", "/abs.md"]);
});

it("finds local markdown links outside code and drops URLs and anchors", () => {
  expect(
    markdownLinks(
      [
        "See [guide](docs/guide.md#setup), [same](docs/guide.md) and [home](<~/a b.md>).",
        "[web](https://example.com/x.md) [mail](mailto:a@b.md) [code](src/x.ts) [enc](my%20notes.md)",
        "`[skip](inline.md)`",
        "```\n[fenced](fenced.md)\n```",
        '[ref]: ../shared/ref.md "Title"',
      ].join("\n"),
    ),
  ).toEqual(["docs/guide.md", "~/a b.md", "my notes.md", "../shared/ref.md"]);
});

const write = (fs: FileSystem.FileSystem, file: string, text: string) =>
  fs
    .makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(file, text)));
const notInternal = () => Effect.succeed(false);

it.effect(
  "reads only the repository and user-owned instruction files, and walks rules recursively",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }),
      );
      const home = path.join(base, "home");
      const outside = path.join(base, "outside");
      const repo = path.join(home, "code", "repo");
      const cwd = path.join(repo, "pkg");
      yield* write(fs, path.join(home, ".claude", "CLAUDE.md"), "@~/.config/one.md @~/.ssh/config");
      yield* write(fs, path.join(home, ".ssh", "config"), "Host *");
      yield* write(fs, path.join(home, ".config", "one.md"), "@two.md");
      yield* write(fs, path.join(home, ".config", "two.md"), "@three.md");
      yield* write(fs, path.join(home, ".config", "three.md"), "@four.md");
      yield* write(fs, path.join(home, ".config", "four.md"), "@five.md");
      yield* write(fs, path.join(home, ".config", "five.md"), "@six.md @one.md");
      yield* write(fs, path.join(home, ".config", "six.md"), "too deep");
      yield* write(fs, path.join(home, "code", "CLAUDE.md"), "ancestor");
      yield* write(fs, path.join(home, "notes.md"), "private");
      yield* write(fs, path.join(repo, ".git", "HEAD"), "ref");
      yield* write(
        fs,
        path.join(repo, "CLAUDE.md"),
        `@.env @${outside}/x.md @~/notes.md @docs/guide.md\n\`\`\`\n@./skipped.md\n\`\`\``,
      );
      yield* write(fs, path.join(repo, ".env"), "SECRET=1");
      yield* write(fs, path.join(repo, "docs", "guide.md"), "guide");
      yield* write(fs, path.join(repo, "skipped.md"), "fenced");
      yield* write(fs, path.join(outside, "x.md"), "outside");
      yield* write(fs, path.join(outside, "planted.md"), "planted");
      yield* write(fs, path.join(cwd, ".claude", "CLAUDE.md"), "nested");
      yield* write(fs, path.join(cwd, ".claude", "rules", "always.md"), "# always");
      yield* write(fs, path.join(cwd, ".claude", "rules", "deep", "nested.md"), "# nested");
      yield* write(
        fs,
        path.join(cwd, ".claude", "rules", "scoped.md"),
        "---\npaths: src/**\n---\n",
      );
      yield* fs.symlink(path.join(outside, "planted.md"), path.join(cwd, "CLAUDE.local.md"));

      const { files } = yield* resolveInstructionFiles(
        FILE_CONVENTIONS.claudeAgent!,
        cwd,
        { home, platform: "linux", configDir: path.join(home, ".claude") },
        notInternal,
      );
      expect(
        files.map((file) => [path.relative(base, file.path), file.scope, file.depth, file.status]),
      ).toEqual([
        ["home/.claude/CLAUDE.md", "global", 0, "expected"],
        ["home/.config/one.md", "import", 1, "expected"],
        ["home/.config/two.md", "import", 2, "expected"],
        ["home/.config/three.md", "import", 3, "expected"],
        ["home/.config/four.md", "import", 4, "expected"],
        ["home/.config/five.md", "import", 5, "expected"],
        ["home/.ssh/config", "import", 1, "secret"],
        ["home/code/CLAUDE.md", "project", 0, "expected"],
        ["home/code/repo/CLAUDE.md", "project", 0, "expected"],
        ["home/code/repo/.env", "import", 1, "secret"],
        ["outside/x.md", "import", 1, "not-read"],
        ["home/notes.md", "import", 1, "not-read"],
        ["home/code/repo/docs/guide.md", "import", 1, "expected"],
        ["home/code/repo/pkg/.claude/CLAUDE.md", "project", 0, "expected"],
        ["home/code/repo/pkg/CLAUDE.local.md", "project", 0, "not-read"],
        ["home/code/repo/pkg/.claude/rules/always.md", "rule", 0, "expected"],
        ["home/code/repo/pkg/.claude/rules/deep/nested.md", "rule", 0, "expected"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lists linked files under the file that links them, two levels deep", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    const repo = path.join(home, "code", "repo");
    const wing = path.join(home, ".config", "wing");
    yield* write(fs, path.join(home, ".claude", "CLAUDE.md"), "@~/.config/wing/BOOT.md");
    yield* write(
      fs,
      path.join(wing, "BOOT.md"),
      "[memory](MEMORY.md) [boot again](BOOT.md) [keys](~/.ssh/keys.md) [repo](~/code/repo/CLAUDE.md)",
    );
    yield* write(fs, path.join(wing, "MEMORY.md"), "[deeper](deep/one.md)");
    yield* write(fs, path.join(wing, "deep", "one.md"), "[too deep](two.md) [back](../MEMORY.md)");
    yield* write(fs, path.join(wing, "deep", "two.md"), "never listed");
    yield* write(fs, path.join(home, ".ssh", "keys.md"), "secret");
    yield* write(fs, path.join(repo, ".git", "HEAD"), "ref");
    for (const name of ["CLAUDE.md", "AGENTS.md"])
      yield* write(fs, path.join(repo, name), "[docs](docs/a.md) [escape](../../notes.md)");
    yield* write(fs, path.join(repo, "docs", "a.md"), "[loop](../CLAUDE.md) [b](b.md)");
    yield* write(fs, path.join(repo, "docs", "b.md"), "b");
    yield* write(fs, path.join(home, "notes.md"), "private");

    for (const [convention, configDir] of [
      [FILE_CONVENTIONS.claudeAgent!, path.join(home, ".claude")],
      [FILE_CONVENTIONS.codex!, path.join(home, ".codex")],
    ] as const) {
      const { files } = yield* resolveInstructionFiles(
        convention,
        repo,
        { home, platform: "linux", configDir },
        notInternal,
      );
      const links = files.filter((file) => file.scope === "link");
      expect(
        links.map((file) => [
          path.relative(home, file.path),
          path.relative(home, file.linkedFrom ?? ""),
          file.depth,
          file.status,
        ]),
      ).toEqual(
        convention.imports
          ? [
              [".config/wing/MEMORY.md", ".config/wing/BOOT.md", 1, "expected"],
              [".config/wing/deep/one.md", ".config/wing/MEMORY.md", 2, "expected"],
              [".ssh/keys.md", ".config/wing/BOOT.md", 1, "secret"],
              ["code/repo/docs/a.md", "code/repo/CLAUDE.md", 1, "expected"],
              ["code/repo/docs/b.md", "code/repo/docs/a.md", 2, "expected"],
              ["notes.md", "code/repo/CLAUDE.md", 1, "not-read"],
            ]
          : [
              ["code/repo/docs/a.md", "code/repo/AGENTS.md", 1, "expected"],
              ["code/repo/CLAUDE.md", "code/repo/docs/a.md", 2, "expected"],
              ["code/repo/docs/b.md", "code/repo/docs/a.md", 2, "expected"],
              ["notes.md", "code/repo/AGENTS.md", 1, "not-read"],
            ],
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("never reads credential or state files a repository imports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    const repo = path.join(home, "code", "evil");
    const targets = [
      ".claude/.credentials.json",
      ".config/gh/hosts.yml",
      ".git-credentials",
      ".docker/config.json",
      ".kube/config",
      ".ssh/config",
      ".envrc",
      ".zsh_history",
      ".t3/userdata/secrets/server-signing-key",
      ".aws/credentials",
      ".ssh/id_ed25519",
      ".env.local",
    ];
    yield* write(fs, path.join(repo, ".git", "HEAD"), "ref");
    for (const target of targets) yield* write(fs, path.join(home, target), `SECRET ${target}`);
    yield* write(fs, path.join(repo, "CLAUDE.md"), targets.map((t) => `@~/${t}`).join("\n"));
    yield* write(
      fs,
      path.join(home, ".claude", "CLAUDE.md"),
      targets.map((t) => `@~/${t}`).join("\n"),
    );
    yield* write(fs, path.join(repo, "state.md"), "internal");

    const { files } = yield* resolveInstructionFiles(
      FILE_CONVENTIONS.claudeAgent!,
      repo,
      { home, platform: "linux", configDir: path.join(home, ".claude") },
      (file) => Effect.succeed(file.endsWith("state.md")),
    );
    const imported = files.filter((file) => file.scope === "import");
    expect(imported.map((file) => path.relative(home, file.path)).toSorted()).toEqual(
      targets.toSorted(),
    );
    expect(imported.filter((file) => file.status === "expected")).toEqual([]);
    const internal = yield* resolveInstructionFiles(
      FILE_CONVENTIONS.claudeAgent!,
      repo,
      { home, platform: "linux", configDir: path.join(home, ".claude") },
      (file) => Effect.succeed(file.endsWith("CLAUDE.md")),
    );
    expect(internal.files.filter((file) => file.status === "expected")).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "lists FIFOs and repository git files without reading them",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }),
      );
      const repo = path.join(home, "code", "repo");
      yield* write(fs, path.join(repo, ".git", "config"), "[remote]\nurl=https://user:tok@host");
      yield* write(fs, path.join(repo, "CLAUDE.md"), "@pipe.md\n@.git/config");
      yield* fs.makeDirectory(path.join(repo, ".claude", "rules"), { recursive: true });
      NodeChildProcess.execFileSync("mkfifo", [path.join(repo, "pipe.md")]);
      NodeChildProcess.execFileSync("mkfifo", [path.join(repo, ".claude", "rules", "f.md")]);

      const { files } = yield* resolveInstructionFiles(
        FILE_CONVENTIONS.claudeAgent!,
        repo,
        { home, platform: "linux", configDir: path.join(home, ".claude") },
        notInternal,
      );
      expect(files.map((file) => [path.relative(repo, file.path), file.status])).toEqual([
        ["CLAUDE.md", "expected"],
        ["pipe.md", "not-read"],
        [".git/config", "secret"],
        [".claude/rules/f.md", "not-read"],
      ]);
      expect(yield* Effect.flip(readBounded(path.join(repo, "pipe.md")))).toMatchObject({
        message: "Could not read the file.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("never treats a dotfiles ~/.git as the repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    const project = path.join(home, "Downloads", "tarball");
    yield* write(fs, path.join(home, ".git", "HEAD"), "ref");
    yield* write(fs, path.join(home, ".pypirc"), "token");
    yield* write(fs, path.join(home, "plain.md"), "notes");
    yield* write(fs, path.join(project, "CLAUDE.md"), "@~/.pypirc\n@~/plain.md\n@local.md");
    yield* write(fs, path.join(project, "local.md"), "local");

    const { files } = yield* resolveInstructionFiles(
      FILE_CONVENTIONS.claudeAgent!,
      project,
      { home, platform: "linux", configDir: path.join(home, ".claude") },
      notInternal,
    );
    expect(files.map((file) => [path.relative(home, file.path), file.status])).toEqual([
      ["Downloads/tarball/CLAUDE.md", "expected"],
      [".pypirc", "not-read"],
      ["plain.md", "not-read"],
      ["Downloads/tarball/local.md", "expected"],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads at most 256 KiB of a file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    const file = path.join(dir, "big.md");
    yield* fs.writeFileString(file, "x".repeat(MAX_READ_BYTES + 4096));
    expect((yield* readBounded(file)).length).toBe(MAX_READ_BYTES);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("walks Codex's chain from the git root and reconciles reported sources", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    const repo = path.join(home, "repo");
    const cwd = path.join(repo, "app");
    yield* write(fs, path.join(home, "codex", "AGENTS.md"), "global");
    yield* write(fs, path.join(home, "AGENTS.md"), "above the git root");
    yield* write(fs, path.join(repo, ".git"), "gitdir: elsewhere");
    yield* write(fs, path.join(repo, "AGENTS.md"), "root");
    yield* write(fs, path.join(cwd, "AGENTS.md"), "plain");
    yield* write(fs, path.join(cwd, "AGENTS.override.md"), "override");

    const { files } = yield* resolveInstructionFiles(
      FILE_CONVENTIONS.codex!,
      cwd,
      { home, platform: "linux", configDir: path.join(home, "codex") },
      notInternal,
    );
    expect(files.map((file) => [path.relative(home, file.path), file.repository])).toEqual([
      ["codex/AGENTS.md", false],
      // Above the nested working folder, but still inside its repository.
      ["repo/AGENTS.md", true],
      ["repo/app/AGENTS.override.md", true],
    ]);
    const rows = reconcileFiles(files, [
      { path: path.join(home, "codex", "AGENTS.md"), bytes: 6 },
      { path: path.join(cwd, "AGENTS.override.md"), bytes: 8 },
      { path: "/elsewhere/AGENTS.md", bytes: 3 },
    ]);
    expect(rows.map((row) => [path.relative(home, row.path), fileStatus(row)])).toEqual([
      ["codex/AGENTS.md", "loaded"],
      ["repo/AGENTS.md", "not-loaded"],
      ["repo/app/AGENTS.override.md", "loaded"],
      [path.relative(home, "/elsewhere/AGENTS.md"), "unexpected"],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const threadId = ThreadId.make("thread-default-context");
const inHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
  );
const runId = RunId.make("run-1");
const codex = ProviderInstanceId.make("codex");

const serviceLayer = (input: {
  readonly home: string;
  readonly footprint?: InstructionFootprint;
  readonly codexHomePath?: string;
  readonly projectRoot?: string;
  /** Counts full context resolutions, which every preview and uncached item read performs. */
  readonly resolutions?: { count: number };
  readonly providerThreadId?: string;
  readonly recordFilters?: Array<unknown>;
  readonly providerThreads?: ReadonlyArray<unknown>;
  readonly providerTurns?: ReadonlyArray<unknown>;
}) =>
  defaultContextLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (_threadId, _fields, filter) => {
            input.recordFilters?.push(filter);
            return Effect.succeed({
              providerThreads: input.providerThreads ?? [],
              providerTurns: input.providerTurns ?? [],
              thread: {
                activeProviderThreadId: input.providerThreadId ?? null,
                deletedAt: null,
                providerInstanceId: codex,
                modelSelection: { instanceId: codex, model: "gpt-5.4" },
                projectId: ProjectId.make("project"),
                worktreePath: input.home,
                interactionMode: "default",
              },
              runs: [{ id: runId, ordinal: 1, requestedAt: DateTime.makeUnsafe(1_000) }],
            } as never);
          },
        }),
        Layer.mock(InstructionFootprints)({
          list: () => Effect.succeed(input.footprint === undefined ? [] : [input.footprint]),
        }),
        Layer.mock(McpAppModelContext.McpAppModelContext)({
          forThread: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.succeed(
              input.projectRoot === undefined
                ? Option.none()
                : Option.some({ workspaceRoot: input.projectRoot } as never),
            ),
        }),
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({
          assertContains: (cwd) => Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
        }),
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed({ driverKind: "codex" } as never),
        }),
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.succeed({
            providerInstances:
              input.codexHomePath === undefined
                ? {}
                : { codex: { driver: "codex", config: { homePath: input.codexHomePath } } },
          } as never),
        }),
        Layer.mock(McpProviderSessions)({ read: () => Effect.undefined }),
        Layer.mock(SkillSources)({
          list: () =>
            Effect.sync(() => {
              if (input.resolutions) input.resolutions.count += 1;
              return { support: "unsupported" as const, skills: [] };
            }),
        }),
        Layer.succeed(
          McpToolCatalog.McpToolCatalog,
          McpToolCatalog.McpToolCatalog.of({
            attach: () => Effect.void,
            list: Effect.succeed([
              { name: "delegate_task", description: "Start a child.", inputSchema: {} },
            ]),
          }),
        ),
        ServerConfig.layerTest(input.home, input.home),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

it.effect("serves file text only for readable ids, and honours the instance's Codex home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    yield* write(fs, path.join(home, ".git", "HEAD"), "ref");
    yield* write(fs, path.join(home, "AGENTS.md"), "x".repeat(40 * 1024));
    yield* write(fs, path.join(home, ".env"), "SECRET=1");
    yield* write(fs, path.join(home, "work-codex", "AGENTS.md"), "work rules [more](more.md)");
    yield* write(fs, path.join(home, "work-codex", "more.md"), "read on demand");
    yield* write(fs, path.join(home, ".codex", "AGENTS.md"), "personal rules");
    const footprint: InstructionFootprint = {
      threadId,
      runId,
      providerInstanceId: codex,
      driver: "codex",
      model: "gpt-5.4",
      capturedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
      source: "test",
      parts: [{ key: "t3:x", label: "x", category: "t3", bytes: 40, estimatedTokens: 10 }],
      instructionSources: [{ path: path.join(home, "AGENTS.md"), bytes: 40 * 1024 }],
    };
    const resolutions = { count: 0 };
    const recordFilters: Array<unknown> = [];
    const context = yield* Layer.build(
      serviceLayer({
        home,
        footprint,
        codexHomePath: path.join(home, "work-codex"),
        resolutions,
        providerThreadId: "provider-thread",
        recordFilters,
      }),
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
    );
    const service = Context.get(context, DefaultContext);
    const preview = yield* inHome(home, service.preview({ threadId }));
    const byId = new Map(preview.items.map((item) => [item.id, item]));
    expect(preview.support).toBe("exact");
    expect(preview.lastTurn?.injectedBytes).toBe(40);
    // The first-turn baseline reads only the active provider thread's turns.
    expect(recordFilters).toContainEqual({
      providerThreadIds: ["provider-thread"],
      providerTurnThreadIds: ["provider-thread"],
    });
    expect(byId.get(`file:${path.join(home, "AGENTS.md")}`)?.status).toBe("loaded");
    expect(byId.has(`file:${path.join(home, "work-codex", "AGENTS.md")}`)).toBe(true);
    expect(byId.has(`file:${path.join(home, ".codex", "AGENTS.md")}`)).toBe(false);
    expect(preview.items.some((item) => item.label === "Prompt separators")).toBe(false);
    expect(preview.notes).toContain(
      "Codex reads only the first 32 KiB of project instructions; these total 40 KiB.",
    );

    const file = yield* inHome(
      home,
      service.itemText({ threadId, itemId: `file:${path.join(home, "work-codex", "AGENTS.md")}` }),
    );
    expect(file.text).toBe("work rules [more](more.md)");
    // Expanding an item reuses the preview's resolution instead of resolving everything again.
    expect(resolutions.count).toBe(1);
    const linked = byId.get(`file:${path.join(home, "work-codex", "more.md")}`);
    expect(linked).toMatchObject({
      parentId: `file:${path.join(home, "work-codex", "AGENTS.md")}`,
      delivery: "on-demand",
      counted: false,
      readable: true,
    });
    expect(linked?.status).toBeUndefined();
    const refused = yield* Effect.flip(
      inHome(home, service.itemText({ threadId, itemId: `file:${path.join(home, ".env")}` })),
    );
    expect(refused.message).toBe("This item has no readable text.");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("takes the starting size only from the first turn of a conversation that began here", () => {
  const instance = ProviderInstanceId.make("claude");
  const runAt = DateTime.makeUnsafe(1_000);
  const startedAt = DateTime.makeUnsafe(3_000);
  const fresh = {
    id: "claude-thread" as never,
    providerInstanceId: instance,
    forkedFrom: null,
    handoffIds: [],
    createdAt: DateTime.makeUnsafe(2_000),
  };
  const turn = (ordinal: number, firstInputTokens?: number, providerThreadId = fresh.id) => ({
    providerThreadId,
    ordinal,
    startedAt,
    tokenUsage: {
      usedTokens: 90_000,
      inputTokens: 90_000,
      ...(firstInputTokens === undefined ? {} : { firstInputTokens }),
      updatedAt: "late",
    },
  });
  const starting = (overrides: Partial<Parameters<typeof startingPrompt>[0]> = {}) =>
    startingPrompt({
      thread: {},
      firstRunRequestedAt: runAt,
      providerThread: fresh,
      turns: [turn(2, 50_000), turn(1, 32_700)],
      instanceId: instance,
      driver: "claudeAgent",
      ...overrides,
    });
  expect(starting()).toEqual({ providerThreadId: fresh.id, promptTokens: 32_700 });
  // A first turn without a recorded first input, from before it was recorded or because its
  // first report carried none, never borrows a later turn's.
  expect(starting({ turns: [turn(1), turn(2, 50_000)] })).toBeNull();
  // After a switch from Codex, a turn of the earlier provider thread never stands in.
  expect(starting({ turns: [turn(1, 20_000, "codex-thread" as never), turn(2, 30_000)] })).toEqual({
    providerThreadId: fresh.id,
    promptTokens: 30_000,
  });
  expect(starting({ turns: [] })).toBeNull();
  // These drivers' first report can describe a later request than the first.
  for (const driver of ["pi", "muse", "opencode"]) expect(starting({ driver })).toBeNull();
  expect(starting({ providerThread: undefined })).toBeNull();
  expect(starting({ instanceId: ProviderInstanceId.make("codex") })).toBeNull();
  expect(starting({ providerThread: { ...fresh, handoffIds: ["handoff" as never] } })).toBeNull();
  expect(
    starting({
      providerThread: { ...fresh, forkedFrom: { providerThreadId: "parent" as never } },
    }),
  ).toBeNull();
  // Imported conversations carry history the first local prompt includes.
  expect(starting({ thread: { historyOrigin: "v1_import" } })).toBeNull();
  expect(
    starting({ providerThread: { ...fresh, createdAt: DateTime.makeUnsafe(500) } }),
  ).toBeNull();
});

it.effect("reports the first request's prompt as the starting size, not the turn's latest", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    const startedAt = DateTime.makeUnsafe(3_000);
    const startingSize = (firstInputTokens: number | undefined) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          serviceLayer({
            home,
            providerThreadId: "provider-thread",
            providerThreads: [
              {
                id: "provider-thread",
                providerInstanceId: codex,
                forkedFrom: null,
                handoffIds: [],
                createdAt: DateTime.makeUnsafe(2_000),
              },
            ],
            providerTurns: [
              {
                id: "turn-1",
                providerThreadId: "provider-thread",
                ordinal: 1,
                startedAt,
                tokenUsage: {
                  usedTokens: 76_000,
                  inputTokens: 76_000,
                  ...(firstInputTokens === undefined ? {} : { firstInputTokens }),
                  updatedAt: "late",
                },
              },
            ],
          }),
        ).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, {}),
        );
        const preview = yield* inHome(
          home,
          Context.get(context, DefaultContext).preview({ threadId }),
        );
        return preview.startingContext;
      });
    expect(yield* startingSize(32_700)).toEqual({
      providerThreadId: "provider-thread",
      promptTokens: 32_700,
    });
    // A turn stored before the first input was recorded gets no starting size.
    expect(yield* startingSize(undefined)).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("previews a draft from its project folder and rejects folders outside it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "default-ctx-" }));
    const projectRoot = path.join(home, "repo");
    yield* write(fs, path.join(projectRoot, "AGENTS.md"), "draft rules");
    const build = (projectRootOption?: string) =>
      Layer.build(
        serviceLayer({ home, ...(projectRootOption ? { projectRoot: projectRootOption } : {}) }),
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
    const previewFor = (service: typeof DefaultContext.Service, worktreePath: string | null) =>
      inHome(
        home,
        service.preview({
          threadId,
          providerInstanceId: codex,
          model: "gpt-5.4",
          draft: { projectId: ProjectId.make("project"), worktreePath, interactionMode: "plan" },
        }),
      );
    const service = Context.get(yield* build(projectRoot), DefaultContext);
    const preview = yield* previewFor(service, null);
    expect(preview.lastTurn).toBeNull();
    expect(preview.cwd).toBe(projectRoot);
    expect(preview.items.find((item) => item.category === "files")?.label).toBe(
      path.join(projectRoot, "AGENTS.md"),
    );
    expect((yield* previewFor(service, projectRoot)).cwd).toBe(projectRoot);
    for (const outside of ["/", home]) {
      expect((yield* Effect.flip(previewFor(service, outside))).message).toBe(
        "This draft's folder is not a known workspace.",
      );
    }
    const missing = Context.get(yield* build(), DefaultContext);
    expect((yield* Effect.flip(previewFor(missing, projectRoot))).message).toBe(
      "This draft's project no longer exists.",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
