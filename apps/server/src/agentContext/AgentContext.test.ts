// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { AgentContext, layer as agentContextLayer } from "./AgentContext.ts";
import * as SkillSources from "./SkillSources.ts";
import { sha256 } from "./sourceFiles.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("project");
const input = { providerInstanceId: claude, projectId };

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const serviceLayer = (home: string, repo: string) =>
  agentContextLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot: repo } as never),
        }),
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed({ driverKind: "claudeAgent" } as never),
        }),
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.succeed({
            providerInstances: {
              claudeAgent: { driver: "claudeAgent", config: { homePath: `${home}/.claude` } },
            },
          } as never),
        }),
        SkillSources.layer.pipe(Layer.provide(Layer.mock(ProviderRegistry)({}))),
        GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
      ).pipe(Layer.provideMerge(ServerConfig.layerTest(home, home))),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/**
 * A repository whose CLAUDE.md is a link to the real instructions file, beside a file the user
 * staged themselves, which a commit from the page must leave staged.
 */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "agent-context-" }));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  yield* fs.makeDirectory(path.join(home, ".claude", "skills", "notes"), { recursive: true });
  yield* fs.writeFileString(
    path.join(home, ".claude", "skills", "notes", "SKILL.md"),
    "---\nname: notes\ndescription: Notes.\n---\n",
  );
  yield* fs.makeDirectory(path.join(repo, "docs"), { recursive: true });
  const real = path.join(repo, "docs", "instructions.md");
  yield* fs.writeFileString(
    real,
    [
      "# Rules",
      "<!-- overwing standards: always -->",
      "- standard-comments",
      "<!-- /overwing standards -->",
      "",
    ].join("\n"),
  );
  yield* fs.symlink("docs/instructions.md", path.join(repo, "CLAUDE.md"));
  yield* fs.writeFileString(path.join(repo, "other.md"), "other\n");
  git(repo, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(repo, "config", key!, value!);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  yield* fs.writeFileString(path.join(repo, "other.md"), "staged by the user\n");
  git(repo, "add", "other.md");
  return { home, repo, real, link: path.join(repo, "CLAUDE.md") };
});

/** Runs `body` against a fresh fixture with HOME pointed at the fixture's home folder. */
const withService = <A, E, R>(
  body: (
    service: AgentContext["Service"],
    files: Effect.Success<typeof fixture>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const files = yield* fixture;
    const service = yield* AgentContext.pipe(Effect.provide(serviceLayer(files.home, files.repo)));
    return yield* body(service, files).pipe(
      Effect.provideService(HostProcess.HomeDirectory, files.home),
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provide(NodeServices.layer),
  );

it.effect("lists sources with their real paths, repository and generated text", () =>
  withService((service, { repo, real }) =>
    Effect.gen(function* () {
      const overview = yield* service.get(input);
      const file = overview.instructions.find((entry) => entry.realPath === real);
      expect(file).toMatchObject({
        path: `${repo}/CLAUDE.md`,
        linked: true,
        repoRoot: repo,
        modified: false,
        editable: true,
        generated: [{ startLine: 2, endLine: 4 }],
      });
      expect(overview.skills).toMatchObject([
        { name: "notes", origin: { kind: "user" }, repoRoot: null, editable: true, listed: true },
      ]);
      expect(overview.repos).toEqual([
        { root: repo, head: git(repo, "rev-parse", "HEAD"), branch: "main" },
      ]);
      // Rows carry no file bodies; text loads through read.
      expect(JSON.stringify(overview)).not.toContain("standard-comments");
      const text = yield* service.read({ ...input, realPath: real });
      expect(text.sha256).toBe(sha256(text.text));
    }),
  ),
);

it.effect("saves only discovered sources, through their real path, and reports conflicts", () =>
  withService((service, { repo, real, link }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = yield* fs.readFileString(real);
      const expectedSha256 = sha256(original);
      const edited = original.replace("# Rules", "# Rules\n\nPrefer small diffs.");

      const refusals = [
        { realPath: `${repo}/other.md`, contents: "x", expectedSha256 },
        { realPath: link, contents: edited, expectedSha256 },
        {
          realPath: real,
          contents: edited.replace("standard-comments", "standard-anything"),
          expectedSha256,
        },
      ];
      for (const request of refusals) {
        const exit = yield* Effect.exit(service.save({ ...input, ...request }));
        expect(exit).toMatchObject({ _tag: "Failure" });
        expect(JSON.stringify(exit)).toContain('"refused"');
      }
      const conflict = yield* Effect.exit(
        service.save({ ...input, realPath: real, contents: edited, expectedSha256: sha256("old") }),
      );
      expect(JSON.stringify(conflict)).toContain('"conflict"');
      expect(yield* fs.readFileString(real)).toBe(original);

      const saved = yield* service.save({
        ...input,
        realPath: real,
        contents: edited,
        expectedSha256,
      });
      expect(saved.sha256).toBe(sha256(edited));
      expect(yield* fs.readFileString(real)).toBe(edited);
      expect(yield* fs.readLink(link)).toBe("docs/instructions.md");
      const after = yield* service.get(input);
      expect(after.instructions.find((entry) => entry.realPath === real)?.modified).toBe(true);
    }),
  ),
);

it.effect("commits only the named sources after checking HEAD, leaving other staged work", () =>
  withService((service, { repo, real }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        real,
        "# Rules\n<!-- overwing standards: always -->\n<!-- /overwing standards -->\n",
      );
      const head = git(repo, "rev-parse", "HEAD");
      const commit = {
        ...input,
        repoRoot: repo,
        realPaths: [real],
        message: "docs: tighten rules",
      };

      const moved = yield* Effect.exit(service.commit({ ...commit, expectedHead: "0".repeat(40) }));
      expect(JSON.stringify(moved)).toContain('"conflict"');
      const foreign = yield* Effect.exit(
        service.commit({ ...commit, realPaths: [`${repo}/other.md`], expectedHead: head }),
      );
      expect(JSON.stringify(foreign)).toContain('"refused"');

      const result = yield* service.commit({ ...commit, expectedHead: head });
      expect(result.commitSha).toBe(git(repo, "rev-parse", "HEAD"));
      expect(git(repo, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual([
        "docs: tighten rules",
        "",
        "docs/instructions.md",
      ]);
      expect(git(repo, "rev-parse", "HEAD~1")).toBe(head);
      expect(git(repo, "status", "--porcelain")).toBe("M  other.md");
    }),
  ),
);
