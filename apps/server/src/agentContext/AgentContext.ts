import {
  AGENT_CONTEXT_MAX_DIRTY,
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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as ServerConfig from "../config.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { providerConfigDir } from "../threadInsights/InstructionFileAllowlist.ts";
import {
  FILE_CONVENTIONS,
  HARD_LINKED_MESSAGE,
  looksLikeSecretName,
  readBounded,
  resolveInstructionFiles,
} from "../threadInsights/instructionFiles.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { isCredentialPath } from "../threadInsights/InstructionFileAllowlist.ts";
import { SkillSources } from "./SkillSources.ts";
import { IndexLockedError, indexLocked, restoreIndex, snapshotIndex } from "./gitIndexSnapshot.ts";
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

const LINKED_OUTSIDE = "Linked outside this project.";
const isIndexLocked = Schema.is(IndexLockedError);

const failed = (message: string) => (cause: unknown) =>
  new AgentContextError({ message, reason: "failed", cause });

const make = Effect.gen(function* () {
  const projects = yield* ProjectService;
  const instances = yield* ProviderInstanceRegistry;
  const settings = yield* ServerSettingsService;
  const skillSources = yield* SkillSources;
  const git = yield* GitVcsDriver;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  // Two saves of one file in this process would otherwise both pass the hash check.
  const saves = yield* Semaphore.make(1);
  // One commit per repository at a time: staging, committing and restoring share its index.
  const commitLocks = new Map<string, Semaphore.Semaphore>();
  const commitLock = (root: string) => {
    let lock = commitLocks.get(root);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      commitLocks.set(root, lock);
    }
    return lock;
  };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
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
    const projectRoot = project.value.workspaceRoot ?? null;
    // A thread's checkout counts only as the project root or a workspace this server knows.
    if (
      input.worktreePath !== undefined &&
      input.worktreePath !== projectRoot &&
      !(yield* knownWorkspaces.assertContains(input.worktreePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ))
    )
      return yield* new AgentContextError({
        message: "This checkout is not a known workspace.",
        reason: "refused",
      });
    const cwd = input.worktreePath ?? projectRoot;
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
            {
              home,
              platform: yield* HostProcess.Platform,
              configDir,
              worktreesDir: serverConfig.worktreesDir,
            },
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
    const projectRepo =
      cwd === null ? null : ((yield* repoRootOf(path.join(cwd, ".git"), home, new Map())) ?? cwd);
    const inProject = (file: string) => projectRepo !== null && within(projectRepo, file);
    // Skills from the user's own config folders; every other skill is judged by where it lives,
    // since providers that report resolved paths cannot say how a skill was linked.
    const userOwned = (skill: (typeof skills.skills)[number]) =>
      skill.origin.kind === "user" || skill.origin.kind === "codex";
    for (const skill of skills.skills) {
      if (readOnly.has(skill.realPath)) continue;
      readOnly.set(
        skill.realPath,
        skill.origin.kind === "plugin"
          ? "Plugin copy: updating the plugin replaces it."
          : skill.origin.kind === "npx"
            ? "Installed by npx skills: change the source, then reinstall."
            : // A cloned project could link a skill to a file in another repository.
              !userOwned(skill) && !inProject(skill.realPath)
              ? LINKED_OUTSIDE
              : yield* readOnlyReason(skill.realPath, home, internal),
      );
    }
    const editable = new Set(
      [...readOnly].flatMap(([file, reason]) => (reason === null ? [file] : [])),
    );
    // Text is read only from Markdown outside credential and server-state paths, whatever
    // linked or imported it.
    const safeToRead = Effect.fnUntraced(function* (realPath: string) {
      return (
        /\.md$/i.test(realPath) && !isCredentialPath(realPath, home) && !(yield* internal(realPath))
      );
    });
    const readable = new Set<string>();
    for (const file of instructions) {
      if (file.status === "expected" && (yield* safeToRead(file.realPath)))
        readable.add(file.realPath);
    }
    for (const skill of skills.skills) {
      if (yield* safeToRead(skill.realPath)) readable.add(skill.realPath);
    }
    // Sources whose repository a commit may name: the project's own, and the user's config.
    const anchors = new Set([
      ...instructions.filter((file) => file.status === "expected").map((file) => file.realPath),
      ...skills.skills
        .filter((skill) => userOwned(skill) || inProject(skill.realPath))
        .map((skill) => skill.realPath),
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
      anchors,
    };
  });

  type Discovery = Effect.Success<ReturnType<typeof discover>>;
  // Reads reuse the latest discovery briefly; overview, save and commit always rediscover.
  const recent = new Map<string, { readonly at: number; readonly found: Discovery }>();
  const discoveryKey = (input: AgentContextGetInput) =>
    `${input.providerInstanceId}\0${input.projectId}\0${input.worktreePath ?? ""}`;
  const discoverFresh = Effect.fnUntraced(function* (input: AgentContextGetInput) {
    const found = yield* discover(input);
    if (recent.size > 32) recent.clear();
    recent.set(discoveryKey(input), { at: yield* Clock.currentTimeMillis, found });
    return found;
  });
  const discoverRecent = Effect.fnUntraced(function* (input: AgentContextGetInput) {
    const cached = recent.get(discoveryKey(input));
    return cached !== undefined && (yield* Clock.currentTimeMillis) - cached.at < 30_000
      ? cached.found
      : yield* discoverFresh(input);
  });

  /** HEAD, branch and every changed or untracked file of a work tree. */
  const repoState = Effect.fnUntraced(function* (root: string) {
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
    // Without optional locks, status never rewrites the index it reports on.
    const status = yield* run("status", [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const dirty: Array<AgentContextRepo["dirty"][number]> = [];
    const tokens = status.stdout.split("\0");
    for (let index = 0; index < tokens.length; index++) {
      const entry = tokens[index]!;
      if (entry.length < 4) continue;
      const untracked = entry.startsWith("??");
      const filePath = entry.slice(3);
      // A rename or copy is followed by its earlier path, which the commit must take too.
      const origPath = entry[0] === "R" || entry[0] === "C" ? tokens[++index] : undefined;
      dirty.push({
        path: filePath,
        ...(origPath ? { origPath } : {}),
        untracked,
        secret: untracked && looksLikeSecretName(path.basename(filePath)),
      });
    }
    const modified = new Set(
      dirty.flatMap((entry) =>
        [entry.path, entry.origPath ?? []].flat().map((file) => path.join(root, file)),
      ),
    );
    const untracked = new Set(
      dirty.filter((entry) => entry.untracked).map((entry) => path.join(root, entry.path)),
    );
    return {
      repo: {
        root,
        head: head.exitCode === 0 ? head.stdout.trim() || null : null,
        branch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
        dirty: dirty.slice(0, AGENT_CONTEXT_MAX_DIRTY),
        dirtyCount: dirty.length,
      } satisfies AgentContextRepo,
      modified,
      untracked,
    };
  });

  const get = Effect.fn("AgentContext.get")(function* (input: AgentContextGetInput) {
    const found = yield* discoverFresh(input);
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
      ([root]) =>
        repoState(root).pipe(
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
        readable: found.readable.has(file.realPath),
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
      const found = yield* discoverRecent(input);
      if (!found.readable.has(input.realPath))
        return yield* new AgentContextError({
          message: "This file is not a readable source for this provider and project.",
          reason: "refused",
        });
      const text = yield* readBounded(input.realPath, { singleLink: true }).pipe(
        Effect.mapError((cause) =>
          cause.message === HARD_LINKED_MESSAGE
            ? new AgentContextError({ message: HARD_LINKED_MESSAGE, reason: "refused", cause })
            : failed("Could not read the file.")(cause),
        ),
      );
      return {
        realPath: input.realPath,
        text,
        sha256: sha256(text),
        generated: generatedRanges(text),
      };
    }),
    save: Effect.fn("AgentContext.save")(function* (input) {
      const found = yield* discoverFresh(input);
      return yield* saves.withPermits(1)(saveSource(input, found.editable));
    }),
    commit: Effect.fn("AgentContext.commit")(function* (input) {
      const found = yield* discoverFresh(input);
      const refused = (message: string) => new AgentContextError({ message, reason: "refused" });
      // Any changed file of a repository holding a discovered source, so one commit can take
      // everything. A skill linked out of the project does not vouch for its target's repository.
      const cache = new Map<string, string | null>();
      let holdsSource = false;
      for (const file of found.anchors) {
        if ((yield* repoRootOf(file, found.home, cache)) === input.repoRoot) {
          holdsSource = true;
          break;
        }
      }
      if (!holdsSource)
        return yield* refused(`${input.repoRoot} holds no agent context source here.`);
      const relative = yield* repoRelativePaths(input.repoRoot, input.realPaths);
      return yield* commitLock(input.repoRoot).withPermits(1)(
        Effect.gen(function* () {
          const state = yield* repoState(input.repoRoot);
          if (state.repo.head !== input.expectedHead)
            return yield* new AgentContextError({
              message: "The repository's HEAD moved since this page loaded. Refresh, then commit.",
              reason: "conflict",
            });
          const unchanged = input.realPaths.find((file) => !state.modified.has(file));
          if (unchanged !== undefined)
            return yield* refused(`${unchanged} has no changes to commit.`);
          const pathspecs = relative.map((file) => `:(top,literal)${file}`);
          const added = relative.flatMap((file, index) =>
            state.untracked.has(input.realPaths[index]!) ? [`:(top,literal)${file}`] : [],
          );
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
          const indexPath = path.resolve(
            input.repoRoot,
            (yield* commitGit("index-path", ["rev-parse", "--git-path", "index"])).stdout.trim(),
          );
          const lockedMessage = `Git's index is locked (${indexPath}.lock). Another Git process may be running; when it finishes, or once you remove a stale lock yourself, commit again.`;
          if (yield* Effect.promise(() => indexLocked(indexPath)))
            return yield* new AgentContextError({ message: lockedMessage, reason: "conflict" });
          const snapshot = yield* Effect.tryPromise({
            try: () => snapshotIndex(indexPath),
            catch: failed("Could not read Git's index before committing."),
          });
          // `--only` commits these paths alone and leaves anything else already staged in place.
          // Untracked files must be in the index first; a failed commit restores the index as it
          // was, whatever the add or a hook changed.
          const staged = Effect.gen(function* () {
            if (added.length > 0) yield* commitGit("add", ["add", "--", ...added]);
            yield* commitGit("commit", [
              "commit",
              "--only",
              "-m",
              input.message,
              "--",
              ...pathspecs,
            ]);
          });
          // A failed restore replaces the commit's error with one that names both.
          yield* staged.pipe(
            Effect.tapError((error) =>
              Effect.tryPromise({
                try: () => restoreIndex(indexPath, snapshot),
                catch: (cause) =>
                  new AgentContextError({
                    message: `${error.message} The index was not restored: ${
                      isIndexLocked(cause) ? lockedMessage : String(cause)
                    }`,
                    reason: "failed",
                    cause,
                  }),
              }),
            ),
          );
          const head = yield* commitGit("head", ["rev-parse", "HEAD"]);
          return { commitSha: head.stdout.trim() };
        }),
      );
    }),
  });
});

export const layer = Layer.effect(AgentContext, make);
