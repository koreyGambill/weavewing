import {
  AgentContextError,
  type AgentContextCommitInput,
  type AgentContextCommitResult,
  type AgentContextGetInput,
  type AgentContextInstruction,
  type AgentContextOverview,
  type AgentContextReadInput,
  type AgentContextRepo,
  type AgentContextSaveInput,
  type AgentContextSaveResult,
  type AgentContextSkill,
  type AgentContextSourceText,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { providerConfigDir } from "../threadInsights/InstructionFileAllowlist.ts";
import {
  FILE_CONVENTIONS,
  readBounded,
  resolveInstructionFiles,
} from "../threadInsights/instructionFiles.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { SkillSources } from "./SkillSources.ts";
import {
  generatedRanges,
  readOnlyReason,
  repoRelativePaths,
  saveSource,
  sha256,
} from "./sourceFiles.ts";

/**
 * Every source that shapes a provider's context in one project: instruction files and skills,
 * where they really live, and the guarded edits and commits Settings › Agent context makes.
 */
export class AgentContext extends Context.Service<
  AgentContext,
  {
    readonly get: (
      input: AgentContextGetInput,
    ) => Effect.Effect<AgentContextOverview, AgentContextError>;
    readonly read: (
      input: AgentContextReadInput,
    ) => Effect.Effect<AgentContextSourceText, AgentContextError>;
    readonly save: (
      input: AgentContextSaveInput,
    ) => Effect.Effect<AgentContextSaveResult, AgentContextError>;
    readonly commit: (
      input: AgentContextCommitInput,
    ) => Effect.Effect<AgentContextCommitResult, AgentContextError>;
  }
>()("t3/agentContext/AgentContext") {}

const failed = (message: string) => (cause: unknown) =>
  new AgentContextError({ message, reason: "failed", cause });

const make = Effect.gen(function* () {
  const projects = yield* ProjectService;
  const instances = yield* ProviderInstanceRegistry;
  const settings = yield* ServerSettingsService;
  const skillSources = yield* SkillSources;
  const git = yield* GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isServerInternal = yield* makeIsServerInternalPath;
  const internal = (file: string) => isServerInternal(file).pipe(Effect.orElseSucceed(() => true));

  const within = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  /** The work tree holding a file; $HOME or above never counts, even with a dotfiles ~/.git. */
  const repoRootOf = Effect.fnUntraced(function* (
    file: string,
    home: string,
    cache: Map<string, string | null>,
  ) {
    const visited: string[] = [];
    let found: string | null = null;
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const cached = cache.get(dir);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(dir);
      if (within(dir, home)) break;
      if (yield* fs.exists(path.join(dir, ".git")).pipe(Effect.orElseSucceed(() => false))) {
        found = dir;
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    for (const dir of visited) cache.set(dir, found);
    return found;
  });

  const discover = Effect.fn("AgentContext.discover")(function* (input: AgentContextGetInput) {
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError(failed("Could not load the project.")));
    if (Option.isNone(project))
      return yield* new AgentContextError({
        message: "This project no longer exists.",
        reason: "refused",
      });
    const cwd = project.value.workspaceRoot ?? null;
    const instance = yield* instances.getInstance(input.providerInstanceId);
    if (instance === undefined)
      return yield* new AgentContextError({
        message: "This provider instance is not configured here.",
        reason: "refused",
      });
    const driver = instance.driverKind;
    const home = yield* HostProcess.HomeDirectory;
    const entry = (yield* settings.getSettings.pipe(Effect.option)).pipe(
      Option.flatMap((value) =>
        Option.fromNullishOr(value.providerInstances[input.providerInstanceId]),
      ),
      Option.getOrUndefined,
    );
    const configDir = yield* providerConfigDir(driver, entry, home).pipe(
      Effect.provideService(Path.Path, path),
    );
    const convention = FILE_CONVENTIONS[driver];
    const instructions =
      convention === undefined || cwd === null
        ? []
        : (yield* resolveInstructionFiles(
            convention,
            cwd,
            { home, platform: yield* HostProcess.Platform, configDir },
            internal,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )).files;
    const skills = yield* skillSources.list({
      instanceId: input.providerInstanceId,
      driver,
      entry,
      cwd,
      configDir,
    });
    const readOnly = new Map<string, string | null>();
    for (const file of instructions) {
      if (file.status === "expected" && !readOnly.has(file.realPath))
        readOnly.set(file.realPath, yield* readOnlyReason(file.realPath, home, internal));
    }
    for (const skill of skills.skills) {
      if (readOnly.has(skill.realPath)) continue;
      readOnly.set(
        skill.realPath,
        skill.origin.kind === "plugin"
          ? "Plugin copy: updating the plugin replaces it."
          : skill.origin.kind === "npx"
            ? "Installed by npx skills: change the source, then reinstall."
            : yield* readOnlyReason(skill.realPath, home, internal),
      );
    }
    const editable = new Set(
      [...readOnly].flatMap(([file, reason]) => (reason === null ? [file] : [])),
    );
    // Readable: every discovered instruction file the resolver read, and every skill file.
    const readable = new Set([
      ...instructions.filter((file) => file.status === "expected").map((file) => file.realPath),
      ...skills.skills.map((skill) => skill.realPath),
    ]);
    return {
      driver,
      cwd,
      home,
      instructionsSupported: convention !== undefined,
      instructions,
      skills,
      readOnly,
      editable,
      readable,
    };
  });

  const repoState = Effect.fnUntraced(function* (root: string, files: ReadonlyArray<string>) {
    const run = (operation: string, args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: `AgentContext.${operation}`,
          cwd: root,
          args,
          allowNonZeroExit: true,
        })
        .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "" })));
    const head = yield* run("head", ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const branch = yield* run("branch", ["symbolic-ref", "--short", "--quiet", "HEAD"]);
    const status = yield* run("status", [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...files.map((file) => path.relative(root, file)),
    ]);
    const modified = new Set(
      status.stdout
        .split("\0")
        .filter((entry) => entry.length > 3)
        .map((entry) => path.join(root, entry.slice(3))),
    );
    return {
      repo: {
        root,
        head: head.exitCode === 0 ? head.stdout.trim() || null : null,
        branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
      } satisfies AgentContextRepo,
      modified,
    };
  });

  const get = Effect.fn("AgentContext.get")(function* (input: AgentContextGetInput) {
    const found = yield* discover(input);
    const realPaths = [
      ...new Set([
        ...found.instructions.map((file) => file.realPath),
        ...found.skills.skills.map((skill) => skill.realPath),
      ]),
    ];
    const cache = new Map<string, string | null>();
    const roots = new Map<string, string | null>();
    for (const file of realPaths) roots.set(file, yield* repoRootOf(file, found.home, cache));
    const byRepo = Map.groupBy(
      realPaths.filter((file) => roots.get(file) != null),
      (file) => roots.get(file)!,
    );
    const repos: AgentContextRepo[] = [];
    const modified = new Set<string>();
    yield* Effect.forEach(
      [...byRepo],
      ([root, files]) =>
        repoState(root, files).pipe(
          Effect.map((state) => {
            repos.push(state.repo);
            for (const file of state.modified) modified.add(file);
          }),
        ),
      { concurrency: 4, discard: true },
    );
    const generated = new Map<string, AgentContextInstruction["generated"]>();
    for (const file of found.instructions) {
      if (file.status !== "expected" || generated.has(file.realPath)) continue;
      generated.set(
        file.realPath,
        generatedRanges(yield* readBounded(file.realPath).pipe(Effect.orElseSucceed(() => ""))),
      );
    }
    const sourceFields = (file: { path: string; realPath: string }) => {
      const reason = found.readOnly.get(file.realPath);
      return {
        path: file.path,
        realPath: file.realPath,
        repoRoot: roots.get(file.realPath) ?? null,
        modified: modified.has(file.realPath),
        editable: reason === null,
        ...(reason ? { readOnlyReason: reason } : {}),
      };
    };
    const notes: string[] = [];
    if (found.cwd === null) notes.push("This project has no folder on this machine.");
    return {
      providerInstanceId: input.providerInstanceId,
      driver: found.driver,
      projectId: input.projectId,
      cwd: found.cwd,
      instructionsSupported: found.instructionsSupported,
      instructions: found.instructions.map((file): AgentContextInstruction => ({
        ...sourceFields(file),
        linked: file.path !== file.realPath,
        bytes: file.bytes,
        scope: file.scope,
        estimatedTokens: Math.ceil(file.bytes / 4),
        status: file.status,
        depth: file.depth,
        generated: generated.get(file.realPath) ?? [],
        ...(file.status === "expected" ? {} : { editable: false }),
        ...(file.linkedFrom === undefined ? {} : { linkedFrom: file.linkedFrom }),
      })),
      skillsSupport: found.skills.support,
      skills: found.skills.skills.map((skill): AgentContextSkill => ({
        ...skill,
        ...sourceFields(skill),
        linked: skill.linked,
      })),
      repos: repos.toSorted((a, b) => a.root.localeCompare(b.root)),
      notes,
    } satisfies AgentContextOverview;
  });

  return AgentContext.of({
    get,
    read: Effect.fn("AgentContext.read")(function* (input) {
      const found = yield* discover(input);
      if (!found.readable.has(input.realPath))
        return yield* new AgentContextError({
          message: "This file is not a readable source for this provider and project.",
          reason: "refused",
        });
      const text = yield* readBounded(input.realPath).pipe(
        Effect.mapError(failed("Could not read the file.")),
      );
      return {
        realPath: input.realPath,
        text,
        sha256: sha256(text),
        generated: generatedRanges(text),
      };
    }),
    save: Effect.fn("AgentContext.save")(function* (input) {
      const found = yield* discover(input);
      return yield* saveSource(input, found.editable);
    }),
    commit: Effect.fn("AgentContext.commit")(function* (input) {
      const found = yield* discover(input);
      const refused = (message: string) => new AgentContextError({ message, reason: "refused" });
      const notEditable = input.realPaths.find((file) => !found.editable.has(file));
      if (notEditable !== undefined)
        return yield* refused(`${notEditable} is not an editable source here.`);
      const cache = new Map<string, string | null>();
      for (const file of input.realPaths) {
        if ((yield* repoRootOf(file, found.home, cache)) !== input.repoRoot)
          return yield* refused(`${file} is not in ${input.repoRoot}.`);
      }
      const relative = yield* repoRelativePaths(input.repoRoot, input.realPaths);
      const state = yield* repoState(input.repoRoot, input.realPaths);
      if (state.repo.head !== input.expectedHead)
        return yield* new AgentContextError({
          message: "The repository's HEAD moved since this page loaded. Refresh, then commit.",
          reason: "conflict",
        });
      if (state.modified.size === 0)
        return yield* refused("These files have no changes to commit.");
      const pathspecs = relative
        .filter((_, index) => state.modified.has(input.realPaths[index]!))
        .map((file) => `:(top,literal)${file}`);
      const commitGit = (operation: string, args: ReadonlyArray<string>) =>
        git
          .execute({
            operation: `AgentContext.commit.${operation}`,
            cwd: input.repoRoot,
            args,
            timeoutMs: 120_000,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AgentContextError({
                  message: cause.detail || "Git could not commit these files.",
                  reason: "failed",
                  cause,
                }),
            ),
          );
      // `--only` commits these paths alone and leaves anything else already staged in place;
      // the add covers a source Git does not track yet.
      yield* commitGit("add", ["add", "--", ...pathspecs]);
      yield* commitGit("commit", ["commit", "--only", "-m", input.message, "--", ...pathspecs]);
      const head = yield* commitGit("head", ["rev-parse", "HEAD"]);
      return { commitSha: head.stdout.trim() };
    }),
  });
});

export const layer = Layer.effect(AgentContext, make);
