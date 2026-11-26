import {
  CommandId,
  GitCommandError,
  type GitManagerServiceError,
  ProjectId,
  type ThreadId,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { newProjectFolderName } from "@t3tools/shared/path";
import { RELEASE_REPOSITORY } from "@t3tools/shared/releaseIdentity";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";

export class ScratchUnavailableError extends Schema.TaggedError<ScratchUnavailableError>()(
  "ScratchUnavailableError",
  {
    baseDir: Schema.String,
    repositoryRoot: Schema.optional(Schema.String),
    scratchRoot: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    if (this.repositoryRoot === undefined) {
      return "Threads without a project are not available on this environment.";
    }
    if (this.scratchRoot !== undefined) {
      return `Threads without a project are off because the configured start folder ${this.scratchRoot} is inside the Git repository ${this.repositoryRoot}. Choose a start folder outside a repository in Settings.`;
    }
    return `Threads without a project are off because the T3 home ${this.baseDir} is inside the Git repository ${this.repositoryRoot}. If that repository was created by mistake, move ${this.repositoryRoot}/.git out of the way; otherwise point T3CODE_HOME (or --base-dir) at a folder outside it. Then restart T3 Code.`;
  }
}

export class ScratchFolderError extends Schema.TaggedError<ScratchFolderError>()(
  "ScratchFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the folder for threads without a project.";
  }
}

export class ScratchProjectError extends Schema.TaggedError<ScratchProjectError>()(
  "ScratchProjectError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project for threads without a project.";
  }
}

/** Where No project threads keep their folders, whether or not this T3 home allows them. */
export const scratchFolderRoot = (baseDir: string, path: Path.Path) =>
  path.resolve(baseDir, "scratch");

export type ScratchError = ScratchUnavailableError | ScratchFolderError | ScratchProjectError;

// The spawner checks cwd before spawning, so NotFound from spawn itself means a missing executable.
const isMissingExecutable = (cause: unknown) =>
  PlatformError.isPlatformError(cause) &&
  cause.reason._tag === "NotFound" &&
  cause.reason.method === "spawn";

const isGitCommandError = Schema.is(GitCommandError);

export class NamedProjectFolderError extends Schema.TaggedError<NamedProjectFolderError>()(
  "NamedProjectFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return isGitCommandError(this.cause) && isMissingExecutable(this.cause.cause)
      ? "Git isn't installed on this machine. Install Git to create a project."
      : "Failed to create the project folder.";
  }
}

export class NamedProjectCreateError extends Schema.TaggedError<NamedProjectCreateError>()(
  "NamedProjectCreateError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project.";
  }
}

export type NamedProjectError = NamedProjectFolderError | NamedProjectCreateError;

export class ManagedProjectFolders extends Context.Service<
  ManagedProjectFolders,
  {
    readonly scratchRoot: Effect.Effect<Option.Option<string>>;
    readonly ensureScratchProject: Effect.Effect<{ readonly projectId: ProjectId }, ScratchError>;
    readonly isScratchProject: (
      projectId: ProjectId,
      cwd?: string | null,
    ) => Effect.Effect<boolean>;
    readonly folderForThread: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<Option.Option<string>, ScratchFolderError>;
    readonly sandboxFolderForThread: (
      threadId: ThreadId,
      previousCwd: string | null,
    ) => Effect.Effect<string, ScratchFolderError>;
    readonly namedProjectsRoot: string;
    /** Removes failed/cancelled creations' folders only while no project owns them. */
    readonly createNamedProject: (input: { readonly name: string }) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly commitError?: string;
      },
      NamedProjectError
    >;
  }
>()("t3/project/ManagedProjectFolders") {}

const ICON_BACKGROUNDS = [
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
] as const;

const MAX_NAMED_FOLDER_ATTEMPTS = 100;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ProjectFaviconResolver finds assets/icon.svg on every clone.
function namedProjectIconSvg(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials =
    words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() ||
    Array.from(name.trim())[0] ||
    "?";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const background = ICON_BACKGROUNDS[hash % ICON_BACKGROUNDS.length];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `  <rect width="64" height="64" rx="14" fill="${background}"/>`,
    `  <text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" fill="#ffffff">${escapeXml(initials)}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function namedProjectReadme(name: string): string {
  return [
    `<img src="assets/icon.svg" width="64" height="64" alt="">`,
    "",
    `# ${name}`,
    "",
    `Created in [Weavewing](https://github.com/${RELEASE_REPOSITORY}).`,
    "",
  ].join("\n");
}

function describeCommitFailure(stderr: string): string {
  if (/identity unknown|tell me who you are|no (name|email) was given/i.test(stderr)) {
    return "Git has no name or email on this machine. Set user.name and user.email, then commit.";
  }
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "Git could not make the first commit.";
}

const isVcsProcessSpawnError = Schema.is(VcsProcessSpawnError);

const isGitMissing = (error: GitManagerServiceError) =>
  error._tag === "GitManagerError" &&
  isVcsProcessSpawnError(error.cause) &&
  PlatformError.isPlatformError(error.cause.cause) &&
  error.cause.cause.reason._tag === "NotFound";

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;

  // Non-recursive mkdir atomically claims a name; racers move on after AlreadyExists.
  const claimFreeFolder = Effect.fnUntraced(function* <E>(
    folderFor: (attempt: number) => Effect.Effect<Option.Option<string>, E>,
    onError: (folder: string, cause: PlatformError.PlatformError) => E,
  ) {
    for (let attempt = 1; ; attempt++) {
      const folder = yield* folderFor(attempt);
      if (Option.isNone(folder)) return folder;
      const claimed = yield* fileSystem.makeDirectory(folder.value).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) => onError(folder.value, cause)),
      );
      if (claimed) return folder;
    }
  });

  const legacyScratchRoot = scratchFolderRoot(config.baseDir, path);
  // A shared start folder must not inherit a parent repository's status or checkpoints.
  const resolveScratchRoot = Effect.fn("ManagedProjectFolders.resolveScratchRoot")(function* (
    setting: string,
  ) {
    const configured = path.resolve(expandHomePath(setting, home));
    const root = (yield* fileSystem.exists(configured))
      ? yield* fileSystem.realPath(configured)
      : legacyScratchRoot;
    const realHome = yield* fileSystem
      .realPath(home)
      .pipe(Effect.orElseSucceed(() => path.resolve(home)));
    const realXwing = yield* fileSystem
      .realPath(path.join(realHome, ".xwing"))
      .pipe(Effect.orElseSucceed(() => path.join(realHome, ".xwing")));
    const dataDirectory = yield* fileSystem
      .realPath(config.baseDir)
      .pipe(Effect.orElseSucceed(() => path.resolve(config.baseDir)));
    const dataRelative = path.relative(root, dataDirectory);
    if (
      root === realHome ||
      root === realXwing ||
      dataRelative === "" ||
      (!dataRelative.startsWith(`..${path.sep}`) &&
        dataRelative !== ".." &&
        !path.isAbsolute(dataRelative))
    )
      return Result.fail(new ScratchUnavailableError({ baseDir: config.baseDir }));
    return yield* gitWorkflow
      .repositoryRoot(root === legacyScratchRoot ? config.baseDir : root)
      .pipe(
        Effect.catchIf(isGitMissing, () => Effect.succeed(null)),
        Effect.flatMap(
          (repositoryRoot): Effect.Effect<Result.Result<string, ScratchUnavailableError>> => {
            if (repositoryRoot === null) return Effect.succeed(Result.succeed(root));
            const unavailable = new ScratchUnavailableError({
              baseDir: config.baseDir,
              repositoryRoot,
              ...(root === legacyScratchRoot ? {} : { scratchRoot: root }),
            });
            return Effect.logWarning(unavailable.message).pipe(Effect.as(Result.fail(unavailable)));
          },
        ),
      );
  });
  const scratchRoots = yield* Cache.makeWith(resolveScratchRoot, {
    capacity: 1,
    // A failed check (say, a git timeout on a busy machine) is not an answer; ask again next time.
    timeToLive: Exit.match({ onSuccess: () => Duration.infinity, onFailure: () => Duration.zero }),
  });
  const scratchProbe = settings.getSettings.pipe(
    Effect.flatMap((value) => Cache.get(scratchRoots, value.scratchStartDirectory)),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed(Result.fail(new ScratchUnavailableError({ baseDir: config.baseDir }))),
    ),
  );
  // A symlinked scratch folder lets the No project live at either the link or its target.
  const scratchProjectRoot = (root: string) =>
    fileSystem.realPath(root).pipe(
      Effect.flatMap((target) =>
        target === root
          ? Effect.succeed(root)
          : projects
              .getByWorkspaceRoot(target)
              .pipe(Effect.map((project) => (Option.isSome(project) ? target : root))),
      ),
      Effect.orElseSucceed(() => root),
    );
  const scratchRoot = scratchProbe.pipe(
    Effect.flatMap((probed) =>
      Result.isSuccess(probed)
        ? scratchProjectRoot(probed.success).pipe(Effect.asSome)
        : Effect.succeedNone,
    ),
  );

  const makeScratchFolder = (folder: string) =>
    fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.mapError((cause) => new ScratchFolderError({ folder, cause })));

  const ensureScratchProject: ManagedProjectFolders["Service"]["ensureScratchProject"] = Effect.gen(
    function* () {
      const probedRoot = yield* scratchProbe.pipe(Effect.flatMap(Effect.fromResult));
      yield* makeScratchFolder(probedRoot);
      const workspaceRoot = yield* scratchProjectRoot(probedRoot);
      const id = yield* random
        .uuidV4()
        .pipe(Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })));
      const bootstrapped = yield* projects
        .bootstrap({
          commandId: CommandId.make(`scratch-project:${id}`),
          projectId: ProjectId.make(id),
          title: "No project",
          workspaceRoot,
        })
        .pipe(
          // bootstrap reads before locking; racing creates return the winner in a conflict.
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              Effect.succeed({
                project: { id: conflict.conflictingProjectId },
                created: false,
              }),
          }),
          Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })),
        );
      if (bootstrapped.created) {
        // Set once at create, so a user's own icon choice is never overwritten.
        yield* projects
          .update({
            commandId: CommandId.make(`scratch-project-icon:${id}`),
            projectId: bootstrapped.project.id,
            projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
          })
          .pipe(Effect.mapError((cause) => new ScratchProjectError({ workspaceRoot, cause })));
      }
      return { projectId: bootstrapped.project.id };
    },
  );

  const isScratchRoot = (projectId: ProjectId, root: string) =>
    projects.getById(projectId).pipe(
      Effect.map(
        Option.exists((project) => path.resolve(project.workspaceRoot) === path.resolve(root)),
      ),
      Effect.orElseSucceed(() => false),
    );

  const isScratchProject: ManagedProjectFolders["Service"]["isScratchProject"] = Effect.fn(
    "ManagedProjectFolders.isScratchProject",
  )(function* (projectId, cwd) {
    const root = yield* scratchRoot;
    const scratch =
      (yield* isScratchRoot(projectId, legacyScratchRoot)) ||
      (Option.isSome(root) && (yield* isScratchRoot(projectId, root.value)));
    if (!scratch || cwd === undefined || cwd === null) return scratch;
    const realCwd = yield* fileSystem
      .realPath(cwd)
      .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
    const legacyRoot = yield* fileSystem
      .realPath(legacyScratchRoot)
      .pipe(Effect.orElseSucceed(() => legacyScratchRoot));
    return (
      realCwd === legacyRoot ||
      path.dirname(realCwd) === legacyRoot ||
      (Option.isSome(root) && realCwd === root.value)
    );
  });

  const folderForThread: ManagedProjectFolders["Service"]["folderForThread"] = Effect.fn(
    "ManagedProjectFolders.folderForThread",
  )(function* (input) {
    const root = yield* scratchRoot;
    if (Option.isNone(root) || !(yield* isScratchProject(input.projectId))) return Option.none();
    yield* makeScratchFolder(root.value);
    return root;
  });

  const sandboxFolderForThread = Effect.fn("ManagedProjectFolders.sandboxFolderForThread")(
    function* (threadId: ThreadId, previousCwd: string | null) {
      yield* makeScratchFolder(legacyScratchRoot);
      const legacyRoot = yield* fileSystem
        .realPath(legacyScratchRoot)
        .pipe(
          Effect.mapError((cause) => new ScratchFolderError({ folder: legacyScratchRoot, cause })),
        );
      if (previousCwd !== null) {
        const previous = yield* fileSystem
          .realPath(previousCwd)
          .pipe(Effect.orElseSucceed(() => null));
        if (previous !== null && path.dirname(previous) === legacyRoot) return previous;
      }
      const folder = path.join(legacyRoot, encodeURIComponent(threadId));
      if (path.dirname(folder) !== legacyRoot)
        return yield* new ScratchFolderError({
          folder,
          cause: "Scratch folder must be inside its root.",
        });
      yield* makeScratchFolder(folder);
      const real = yield* fileSystem
        .realPath(folder)
        .pipe(Effect.mapError((cause) => new ScratchFolderError({ folder, cause })));
      if (real !== folder)
        return yield* new ScratchFolderError({
          folder,
          cause: "Scratch folder must not be a symlink.",
        });
      return folder;
    },
  );

  const namedProjectsRoot = path.resolve(config.baseDir, "projects");

  const claimNamedFolder = Effect.fn("ManagedProjectFolders.claimNamedFolder")(function* (
    name: string,
  ) {
    yield* fileSystem
      .makeDirectory(namedProjectsRoot, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new NamedProjectFolderError({ folder: namedProjectsRoot, cause }),
        ),
      );
    const folderName = newProjectFolderName(name);
    const claimed = yield* claimFreeFolder(
      (attempt) =>
        Effect.succeed(
          attempt > MAX_NAMED_FOLDER_ATTEMPTS
            ? Option.none()
            : Option.some(
                path.join(
                  namedProjectsRoot,
                  attempt === 1 ? folderName : `${folderName}-${attempt}`,
                ),
              ),
        ),
      (folder, cause) => new NamedProjectFolderError({ folder, cause }),
    );
    if (Option.isSome(claimed)) return claimed.value;
    return yield* new NamedProjectFolderError({
      folder: path.join(namedProjectsRoot, folderName),
      cause: `Every folder name for "${folderName}" is taken.`,
    });
  });

  const scaffoldRepository = Effect.fn("ManagedProjectFolders.scaffoldRepository")(function* (
    cwd: string,
    name: string,
  ) {
    const branch =
      (yield* git
        .readConfigValue(cwd, "init.defaultBranch")
        .pipe(Effect.orElseSucceed(() => null))) ?? "main";
    yield* git.execute({
      operation: "ManagedProjectFolders.init",
      cwd,
      args: ["init", `--initial-branch=${branch}`],
      timeoutMs: 10_000,
    });
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), namedProjectReadme(name));
    yield* fileSystem.makeDirectory(path.join(cwd, "assets"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "assets", "icon.svg"),
      namedProjectIconSvg(name),
    );
    // Force explicit filenames so global ignore rules cannot drop them, and keep
    // core.safecrlf=true from refusing the LF files under CRLF conversion.
    yield* git.execute({
      operation: "ManagedProjectFolders.add",
      cwd,
      args: ["-c", "core.safecrlf=false", "add", "--force", "--", "README.md", "assets/icon.svg"],
      timeoutMs: 10_000,
    });
    return yield* git
      .execute({
        operation: "ManagedProjectFolders.commit",
        cwd,
        args: ["commit", "--message", "Initial commit"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? undefined : describeCommitFailure(result.stderr),
        ),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
  });

  const createNamedProject: ManagedProjectFolders["Service"]["createNamedProject"] = Effect.fn(
    "ManagedProjectFolders.createNamedProject",
  )(function* (input) {
    const workspaceRoot = yield* claimNamedFolder(input.name);
    const removeFolder = fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore);
    const prepared = yield* Effect.all([
      scaffoldRepository(workspaceRoot, input.name).pipe(
        Effect.mapError((cause) => new NamedProjectFolderError({ folder: workspaceRoot, cause })),
      ),
      random
        .uuidV4()
        .pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause }))),
    ]).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeFolder)));
    const [commitError, id] = prepared;
    const project = yield* projects
      .create({
        commandId: CommandId.make(`named-project:${id}`),
        projectId: ProjectId.make(id),
        title: input.name,
        workspaceRoot,
      })
      .pipe(
        // Re-check ownership before deleting rejected creations; interruption after commit or conflicts can leave an owner.
        Effect.tapError((error) =>
          error._tag === "ProjectConflictError"
            ? Effect.void
            : projects.getByWorkspaceRoot(workspaceRoot).pipe(
                Effect.flatMap((owner) => (Option.isNone(owner) ? removeFolder : Effect.void)),
                Effect.ignore,
              ),
        ),
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      );
    return {
      projectId: project.id,
      workspaceRoot,
      ...(commitError === undefined ? {} : { commitError }),
    };
  });

  return ManagedProjectFolders.of({
    scratchRoot,
    ensureScratchProject,
    isScratchProject,
    folderForThread,
    namedProjectsRoot,
    sandboxFolderForThread,
    createNamedProject,
  });
});

export const layer = Layer.effect(ManagedProjectFolders, make);
