// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AGENT_CONTEXT_MAX_DIRTY,
  AgentContextCommitInput,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
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

const serviceLayer = (home: string, repo: string, worktree: string, lookups: { count: number }) =>
  agentContextLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.sync(() => {
              lookups.count += 1;
            }).pipe(Effect.andThen(Effect.succeedSome({ workspaceRoot: repo } as never))),
        }),
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({
          assertContains: (cwd) =>
            cwd === worktree
              ? Effect.void
              : Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
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
      "<!-- overwing standards index -->",
      "- standard-comments",
      "<!-- /overwing standards index -->",
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
  // Project skills a cloned repository could plant: links to a credential, a non-Markdown
  // secret and a file outside the repository, beside an untracked skill of its own.
  const skills = path.join(repo, ".claude", "skills");
  const skill = "---\nname: x\n---\n";
  for (const [name, target] of [
    ["leak", path.join(home, ".ssh", "notes.md")],
    ["key", path.join(home, "signing-key")],
    ["outside", path.join(root, "elsewhere", "notes.md")],
  ] as const) {
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, skill);
    yield* fs.makeDirectory(path.join(skills, name), { recursive: true });
    yield* fs.symlink(target, path.join(skills, name, "SKILL.md"));
  }
  yield* fs.makeDirectory(path.join(skills, "drafts"), { recursive: true });
  const draft = path.join(skills, "drafts", "SKILL.md");
  yield* fs.writeFileString(draft, skill);
  // A hard link names a secret inside the repository, where no symlink check sees it.
  yield* fs.writeFileString(path.join(home, "token"), skill);
  yield* fs.makeDirectory(path.join(skills, "hard"), { recursive: true });
  yield* fs.link(path.join(home, "token"), path.join(skills, "hard", "SKILL.md"));
  yield* fs.writeFileString(path.join(repo, ".env"), "TOKEN=1\n");
  const worktree = path.join(root, "worktree");
  yield* fs.makeDirectory(worktree, { recursive: true });
  yield* fs.writeFileString(path.join(worktree, "CLAUDE.md"), "# Worktree rules\n");
  return { root, home, repo, real, draft, worktree, link: path.join(repo, "CLAUDE.md") };
});

/** Runs `body` against a fresh fixture with HOME pointed at the fixture's home folder. */
const withService = <A, E, R>(
  body: (
    service: AgentContext["Service"],
    files: Effect.Success<typeof fixture> & { readonly lookups: { count: number } },
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const files = yield* fixture;
    const lookups = { count: 0 };
    const service = yield* AgentContext.pipe(
      Effect.provide(serviceLayer(files.home, files.repo, files.worktree, lookups)),
    );
    return yield* body(service, { ...files, lookups }).pipe(
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
      expect(overview.skills.find((skill) => skill.name === "notes")).toMatchObject({
        origin: { kind: "user" },
        repoRoot: null,
        editable: true,
        listed: true,
      });
      // Commit offers every changed file of the repository, untracked ones marked.
      expect(overview.repos).toEqual([
        {
          root: repo,
          head: git(repo, "rev-parse", "HEAD"),
          branch: "main",
          dirty: [
            { path: "other.md", untracked: false, secret: false },
            { path: ".claude/skills/drafts/SKILL.md", untracked: true, secret: false },
            { path: ".claude/skills/hard/SKILL.md", untracked: true, secret: false },
            { path: ".claude/skills/key/SKILL.md", untracked: true, secret: false },
            { path: ".claude/skills/leak/SKILL.md", untracked: true, secret: false },
            { path: ".claude/skills/outside/SKILL.md", untracked: true, secret: false },
            // Commit starts a secret-looking untracked file unchecked.
            { path: ".env", untracked: true, secret: true },
          ],
          dirtyCount: 7,
        },
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
        "# Rules\n<!-- overwing standards index -->\n<!-- /overwing standards index -->\n",
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
      for (const realPaths of [[`${repo}/CLAUDE.md`], [`${repo}-other/notes.md`]]) {
        const refusedCommit = yield* Effect.exit(
          service.commit({ ...commit, realPaths, expectedHead: head }),
        );
        expect(JSON.stringify(refusedCommit), realPaths[0]).toContain('"refused"');
      }

      const result = yield* service.commit({ ...commit, expectedHead: head });
      expect(result.commitSha).toBe(git(repo, "rev-parse", "HEAD"));
      expect(git(repo, "show", "--name-only", "--format=%s", "HEAD").split("\n")).toEqual([
        "docs: tighten rules",
        "",
        "docs/instructions.md",
      ]);
      expect(git(repo, "rev-parse", "HEAD~1")).toBe(head);
      expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("M  other.md");

      // The rest of the repository, including files that are not sources and untracked ones.
      const rest = (yield* service.get(input)).repos[0]!;
      yield* service.commit({
        ...commit,
        realPaths: rest.dirty.map((entry) => `${repo}/${entry.path}`),
        message: "chore: commit everything",
        expectedHead: rest.head,
      });
      expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    }),
  ),
);

it.effect("reads skill text only from Markdown outside credential and server state", () =>
  withService((service, { root, home, repo }) =>
    Effect.gen(function* () {
      const overview = yield* service.get(input);
      for (const realPath of [`${home}/.ssh/notes.md`, `${home}/signing-key`]) {
        expect(overview.skills.find((skill) => skill.realPath === realPath)?.readable).toBe(false);
        const exit = yield* Effect.exit(service.read({ ...input, realPath }));
        expect(JSON.stringify(exit), realPath).toContain('"refused"');
      }
      const hardLinked = yield* Effect.exit(
        service.read({ ...input, realPath: `${repo}/.claude/skills/hard/SKILL.md` }),
      );
      expect(JSON.stringify(hardLinked)).toContain('"refused"');
      // A skill linked into another repository does not make that repository committable.
      git(`${root}/elsewhere`, "init", "-q", "-b", "main");
      const foreignRepo = yield* Effect.exit(
        service.commit({
          ...input,
          repoRoot: `${root}/elsewhere`,
          realPaths: [`${root}/elsewhere/notes.md`],
          message: "chore: planted",
          expectedHead: null,
        }),
      );
      expect(JSON.stringify(foreignRepo)).toContain("holds no agent context source");
      // A project skill linked out of the repository must not make that file writable.
      const outside = overview.skills.find((skill) => skill.name === "outside");
      expect(outside).toMatchObject({
        editable: false,
        readOnlyReason: "Linked outside this project.",
      });
      const text = yield* service.read({ ...input, realPath: `${root}/elsewhere/notes.md` });
      const exit = yield* Effect.exit(
        service.save({
          ...input,
          realPath: `${root}/elsewhere/notes.md`,
          contents: "changed",
          expectedSha256: text.sha256,
        }),
      );
      expect(JSON.stringify(exit)).toContain('"refused"');
      expect(overview.skills.find((skill) => skill.name === "drafts")?.editable).toBe(true);
      expect(repo).toBeTruthy();
    }),
  ),
);

it.effect("lets one of two concurrent saves from the same version through", () =>
  withService((service, { real }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const original = yield* fs.readFileString(real);
      const expectedSha256 = sha256(original);
      const exits = yield* Effect.forEach(
        ["first", "second"],
        (name) =>
          Effect.exit(
            service.save({
              ...input,
              realPath: real,
              contents: original.replace("# Rules", `# Rules ${name}`),
              expectedSha256,
            }),
          ),
        { concurrency: "unbounded" },
      );
      expect(exits.filter((exit) => exit._tag === "Success")).toHaveLength(1);
      const failure = exits.find((exit) => exit._tag === "Failure");
      expect(JSON.stringify(failure)).toContain('"conflict"');
    }),
  ),
);

it.effect("leaves the index as it was when a hook rejects the commit", () =>
  withService((service, { root, repo, real, draft }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${root}/reject-hooks`, { recursive: true });
      // A formatter-style hook rewrites a file the commit added, then rejects the commit.
      yield* fs.writeFileString(
        `${root}/reject-hooks/pre-commit`,
        `#!/bin/sh\nprintf 'formatted\\n' >> '${draft}'\nexit 1\n`,
      );
      yield* fs.chmod(`${root}/reject-hooks/pre-commit`, 0o755);
      git(repo, "config", "core.hooksPath", `${root}/reject-hooks`);
      yield* fs.writeFileString(
        real,
        "# Rules\n<!-- overwing standards index -->\n<!-- /overwing standards index -->\n",
      );
      const index = `${repo}/.git/index`;
      const before = yield* fs.readFile(index);
      const exit = yield* Effect.exit(
        service.commit({
          ...input,
          repoRoot: repo,
          realPaths: [real, draft],
          message: "docs: rejected",
          expectedHead: git(repo, "rev-parse", "HEAD"),
        }),
      );
      expect(exit._tag).toBe("Failure");
      expect(Buffer.from(yield* fs.readFile(index)).equals(Buffer.from(before))).toBe(true);
      expect(git(repo, "status", "--porcelain", "--", draft)).toBe(
        "?? .claude/skills/drafts/SKILL.md",
      );

      // Git killed mid-commit leaves its lock: the failure says so and leaves the lock alone.
      yield* fs.writeFileString(`${root}/reject-hooks/pre-commit`, "#!/bin/sh\nkill -9 $PPID\n");
      const killed = yield* Effect.exit(
        service.commit({
          ...input,
          repoRoot: repo,
          realPaths: [draft],
          message: "docs: killed",
          expectedHead: git(repo, "rev-parse", "HEAD"),
        }),
      );
      expect(JSON.stringify(killed)).toContain("The index was not restored");
      expect(JSON.stringify(killed)).toContain("index.lock");
      expect(yield* fs.exists(`${index}.lock`)).toBe(true);
      yield* fs.remove(`${index}.lock`);

      // A lock another Git process holds is reported, and left for that process.
      git(repo, "config", "core.hooksPath", `${root}/no-hooks`);
      yield* fs.writeFileString(`${index}.lock`, "");
      const locked = yield* Effect.exit(
        service.commit({
          ...input,
          repoRoot: repo,
          realPaths: [draft],
          message: "docs: locked",
          expectedHead: git(repo, "rev-parse", "HEAD"),
        }),
      );
      expect(JSON.stringify(locked)).toContain("index.lock");
      expect(yield* fs.exists(`${index}.lock`)).toBe(true);
    }),
  ),
);

it.effect("reads a checkout the thread uses and reuses discovery for text reads", () =>
  withService((service, { worktree, real, lookups }) =>
    Effect.gen(function* () {
      const overview = yield* service.get({ ...input, worktreePath: worktree });
      expect(overview.cwd).toBe(worktree);
      expect(overview.instructions.map((file) => file.path)).toContain(`${worktree}/CLAUDE.md`);
      const unknown = yield* Effect.exit(service.get({ ...input, worktreePath: `${worktree}-x` }));
      expect(JSON.stringify(unknown)).toContain('"refused"');

      const before = lookups.count;
      yield* service.get(input);
      yield* service.read({ ...input, realPath: real });
      yield* service.read({ ...input, realPath: real });
      expect(lookups.count - before).toBe(1);
    }),
  ),
);

it.effect("commits both sides of a rename and one of two concurrent commits", () =>
  withService((service, { repo, draft }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${repo}/notes.md`, "Long enough notes that Git sees a rename.\n");
      git(repo, "add", "notes.md");
      git(repo, "commit", "-q", "--only", "-m", "notes", "--", "notes.md");
      git(repo, "mv", "notes.md", "renamed.md");
      const renamed = (yield* service.get(input)).repos[0]!;
      expect(renamed.dirty.find((entry) => entry.path === "renamed.md")).toEqual({
        path: "renamed.md",
        origPath: "notes.md",
        untracked: false,
        secret: false,
      });
      yield* service.commit({
        ...input,
        repoRoot: repo,
        realPaths: [`${repo}/renamed.md`, `${repo}/notes.md`],
        message: "docs: rename",
        expectedHead: renamed.head,
      });
      expect(git(repo, "show", "--name-status", "--format=", "HEAD")).toMatch(
        /^R\d+\tnotes\.md\trenamed\.md$/,
      );
      expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("M  other.md");

      const head = git(repo, "rev-parse", "HEAD");
      const exits = yield* Effect.forEach(
        ["first", "second"],
        (name) =>
          Effect.exit(
            service.commit({
              ...input,
              repoRoot: repo,
              realPaths: [draft],
              message: `docs: ${name}`,
              expectedHead: head,
            }),
          ),
        { concurrency: "unbounded" },
      );
      expect(exits.filter((exit) => exit._tag === "Success")).toHaveLength(1);
      expect(git(repo, "status", "--porcelain", "--", draft)).toBe("");
      expect(git(repo, "rev-list", "--count", `${head}..HEAD`)).toBe("1");
    }),
  ),
);

it.effect("lists up to the cap of changed files and says how many there are", () =>
  withService((service, { repo }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${repo}/many`);
      for (let index = 0; index < AGENT_CONTEXT_MAX_DIRTY; index++)
        yield* fs.writeFileString(`${repo}/many/${index}.txt`, "x");
      const repoState = (yield* service.get(input)).repos[0]!;
      expect(repoState.dirty).toHaveLength(AGENT_CONTEXT_MAX_DIRTY);
      expect(repoState.dirtyCount).toBe(AGENT_CONTEXT_MAX_DIRTY + 7);
      // Every listed row, with a rename's second path, fits one commit request.
      const decode = Schema.decodeUnknownExit(AgentContextCommitInput);
      const realPaths = Array.from(
        { length: AGENT_CONTEXT_MAX_DIRTY * 2 },
        (_, index) => `${repo}/many/${index}.txt`,
      );
      expect(
        decode({ ...input, repoRoot: repo, realPaths, message: "chore: many", expectedHead: null })
          ._tag,
      ).toBe("Success");
    }),
  ),
);
