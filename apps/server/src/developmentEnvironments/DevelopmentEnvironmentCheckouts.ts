import {
  DevelopmentEnvironmentCheckoutUnavailableError,
  type DevelopmentEnvironmentCheckoutChoice,
  type OrchestrationV2DevelopmentEnvironmentCheckout,
  XwingEnvironmentId,
  type XwingListError,
  type XwingRepositoryDetail,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as SqlClient from "effect/sql/SqlClient";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { type WorktreeOwnership, WorktreeRemovalOwnership } from "../vcs/worktreeRemoval.ts";
import * as XwingEnvironments from "../xwing/XwingEnvironments.ts";
import * as XwingOperations from "../xwing/XwingOperations.ts";

export { DevelopmentEnvironmentCheckoutUnavailableError };

/**
 * Xwing could not bring a bound thread's checkout back where the thread recorded it. The thread
 * keeps its binding; the message names the branch its work survives on.
 */
export class DevelopmentEnvironmentCheckoutRecoveryError extends Schema.TaggedError<DevelopmentEnvironmentCheckoutRecoveryError>()(
  "DevelopmentEnvironmentCheckoutRecoveryError",
  {
    xwingEnvironmentId: Schema.String,
    branch: Schema.NullOr(Schema.String),
    reason: Schema.Literals(["environment-missing", "checkout-moved", "not-restored"]),
  },
) {
  override get message(): string {
    const problem = {
      "environment-missing": "Xwing no longer has this thread's development environment",
      "checkout-moved":
        "Xwing brought back this thread's development environment, but not at the thread's folder",
      "not-restored": "Xwing could not bring back this thread's checkout",
    }[this.reason];
    const work =
      this.branch === null
        ? "The thread has no branch to continue from"
        : `Its branch '${this.branch}' remains in the project repository`;
    return `${problem}. ${work}; the thread was not moved to another checkout.`;
  }
}

export interface ResolvedDevelopmentEnvironmentCheckout extends OrchestrationV2DevelopmentEnvironmentCheckout {
  /** The branch Xwing reports checked out, or null when it reports none. */
  readonly branch: string | null;
}

/**
 * Resolves an Xwing environment to its checkout of one repository. Callers pass only the
 * environment id and the project root; the checkout path always comes from Xwing, at the
 * project's folder within its repository.
 */
export class DevelopmentEnvironmentCheckouts extends Context.Service<
  DevelopmentEnvironmentCheckouts,
  {
    readonly resolve: (input: {
      readonly xwingEnvironmentId: string;
      readonly workspaceRoot: string;
    }) => Effect.Effect<
      ResolvedDevelopmentEnvironmentCheckout,
      DevelopmentEnvironmentCheckoutUnavailableError
    >;
    /**
     * Every active environment's present checkout of the project's repository, from Xwing's
     * catalog. Git identity is read once per distinct source, never per environment's state.
     */
    readonly list: (input: {
      readonly workspaceRoot: string;
    }) => Effect.Effect<ReadonlyArray<DevelopmentEnvironmentCheckoutChoice>, XwingListError>;
    /**
     * Brings back a bound thread's missing checkout through Xwing: restores an archived
     * environment, and re-adds the repository on `branch` when an active one lacks its checkout.
     * Succeeds only when the checkout is back at `checkoutPath`; never moves the thread.
     */
    readonly recover: (input: {
      readonly xwingEnvironmentId: string;
      readonly repositorySource: string;
      readonly workspaceRoot: string;
      readonly checkoutPath: string;
      readonly branch: string | null;
    }) => Effect.Effect<void, DevelopmentEnvironmentCheckoutRecoveryError>;
  }
>()("t3/developmentEnvironments/DevelopmentEnvironmentCheckouts") {}

const decodeXwingEnvironmentId = Schema.decodeUnknownOption(XwingEnvironmentId);

export const makeGitCheckoutLookup = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Symlinked roots must still match the registered checkout.
  const canonical = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  // Worktrees and subfolders of one repository share its common directory; null outside Git.
  const repositoryOf = Effect.fn("DevelopmentEnvironmentCheckouts.repositoryOf")(function (
    cwd: string,
  ) {
    return git
      .execute({
        operation: "DevelopmentEnvironmentCheckouts.repositoryOf",
        cwd,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.flatMap((result) => {
          const [commonDir, topLevel, ...rest] = result.stdout
            .replace(/\r?\n$/u, "")
            .split(/\r?\n/u);
          return result.exitCode !== 0 || !commonDir || !topLevel || rest.length > 0
            ? Effect.succeed(null)
            : Effect.all({ commonDir: canonical(commonDir), topLevel: canonical(topLevel) });
        }),
        Effect.orElseSucceed(() => null),
      );
  });
  return { canonical, repositoryOf };
});

const makeXwing = Effect.gen(function* () {
  const xwing = yield* XwingEnvironments.XwingEnvironments;
  const operations = yield* XwingOperations.XwingOperations;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { canonical, repositoryOf } = yield* makeGitCheckoutLookup;
  const isDirectory = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  /** The project's repository identity and its folder within the repository; null outside it. */
  const projectIdentity = Effect.fnUntraced(function* (workspaceRoot: string) {
    const root = yield* canonical(workspaceRoot);
    const repository = yield* repositoryOf(root);
    const folder = repository === null ? "" : path.relative(repository.topLevel, root);
    if (folder.startsWith("..") || path.isAbsolute(folder)) return null;
    return { root, commonDir: repository?.commonDir ?? null, folder };
  });

  const sourceMatches = (
    project: { readonly root: string; readonly commonDir: string | null },
    sourcePath: string,
  ) =>
    canonical(sourcePath).pipe(
      Effect.flatMap((sourceRoot) =>
        project.commonDir === null
          ? Effect.succeed(sourceRoot === project.root)
          : Effect.map(
              repositoryOf(sourceRoot),
              (source) => source?.commonDir === project.commonDir,
            ),
      ),
    );

  const list = Effect.fn("DevelopmentEnvironmentCheckouts.list")(function* (input: {
    readonly workspaceRoot: string;
  }) {
    const environments = yield* xwing.list();
    const project = yield* projectIdentity(input.workspaceRoot);
    if (project === null) return [];
    const candidates = environments.flatMap((environment) =>
      environment.status === "active"
        ? environment.repositories
            .filter((repository) => repository.present)
            .map((repository) => ({ environment, repository }))
        : [],
    );
    const sources = [...new Set(candidates.map(({ repository }) => repository.sourcePath))];
    const matching = new Set(
      (yield* Effect.forEach(
        sources,
        (source) =>
          Effect.map(sourceMatches(project, source), (matches) => (matches ? source : null)),
        { concurrency: 4 },
      )).filter((source) => source !== null),
    );
    const choices = yield* Effect.forEach(
      candidates.filter(({ repository }) => matching.has(repository.sourcePath)),
      ({ environment, repository }) => {
        const checkoutPath = path.join(path.resolve(repository.path), project.folder);
        return Effect.map(
          project.folder === "" ? Effect.succeed(true) : isDirectory(checkoutPath),
          (present): DevelopmentEnvironmentCheckoutChoice | null =>
            present
              ? {
                  xwingEnvironmentId: environment.id,
                  ...(environment.number === undefined ? {} : { number: environment.number }),
                  name: environment.name,
                  ...(environment.ticket === undefined ? {} : { ticket: environment.ticket }),
                  repositoryName: repository.name,
                  branch: repository.branch,
                  checkoutPath,
                }
              : null,
        );
      },
      { concurrency: 4 },
    );
    return choices.filter((choice) => choice !== null);
  });

  const resolve = Effect.fn("DevelopmentEnvironmentCheckouts.resolve")(function* (input: {
    readonly xwingEnvironmentId: string;
    readonly workspaceRoot: string;
  }) {
    const unavailable = (reason: DevelopmentEnvironmentCheckoutUnavailableError["reason"]) =>
      new DevelopmentEnvironmentCheckoutUnavailableError({
        xwingEnvironmentId: input.xwingEnvironmentId,
        reason,
      });
    // Xwing's stderr stays in the server log; it can name paths and secrets clients must not see.
    const unavailableFrom =
      (reason: DevelopmentEnvironmentCheckoutUnavailableError["reason"]) => (cause: unknown) =>
        Effect.logWarning("Xwing could not resolve a development environment", cause).pipe(
          Effect.andThen(Effect.fail(unavailable(reason))),
        );
    const id = decodeXwingEnvironmentId(input.xwingEnvironmentId);
    if (Option.isNone(id)) return yield* unavailable("environment-missing");
    const environment = yield* xwing.inspect(id.value).pipe(
      Effect.catchTags({
        XwingEnvironmentNotFoundError: () => Effect.fail(unavailable("environment-missing")),
        XwingUnavailableError: unavailableFrom("xwing-unavailable"),
        XwingCommandError: unavailableFrom("xwing-unavailable"),
        XwingOutputError: unavailableFrom("xwing-unavailable"),
      }),
    );
    const project = yield* projectIdentity(input.workspaceRoot);
    if (project === null) return yield* unavailable("repository-missing");
    let repository: XwingRepositoryDetail | undefined;
    for (const candidate of environment.repositories) {
      if (yield* sourceMatches(project, candidate.sourcePath)) {
        repository = candidate;
        break;
      }
    }
    if (repository === undefined) return yield* unavailable("repository-missing");
    const checkoutPath = path.join(path.resolve(repository.path), project.folder);
    if (!(yield* isDirectory(checkoutPath))) return yield* unavailable("checkout-missing");
    return {
      xwingEnvironmentId: environment.id,
      repositorySource: repository.sourcePath,
      checkoutPath,
      number:
        environment.number !== undefined &&
        Number.isInteger(environment.number) &&
        environment.number >= 0
          ? environment.number
          : null,
      name: environment.name,
      branch: repository.branch === "" ? null : repository.branch,
    } satisfies ResolvedDevelopmentEnvironmentCheckout;
  });

  const recover = Effect.fn("DevelopmentEnvironmentCheckouts.recover")(function* (input: {
    readonly xwingEnvironmentId: string;
    readonly repositorySource: string;
    readonly workspaceRoot: string;
    readonly checkoutPath: string;
    readonly branch: string | null;
  }) {
    const refused = (reason: DevelopmentEnvironmentCheckoutRecoveryError["reason"]) =>
      new DevelopmentEnvironmentCheckoutRecoveryError({
        xwingEnvironmentId: input.xwingEnvironmentId,
        branch: input.branch,
        reason,
      });
    // Xwing's output stays in the server log, as for `resolve`.
    const refusedFrom =
      (reason: DevelopmentEnvironmentCheckoutRecoveryError["reason"]) => (cause: unknown) =>
        Effect.logWarning("Xwing could not recover a development environment checkout", cause).pipe(
          Effect.andThen(Effect.fail(refused(reason))),
        );
    const id = decodeXwingEnvironmentId(input.xwingEnvironmentId);
    if (Option.isNone(id)) return yield* refused("environment-missing");
    const environment = (yield* xwing.list().pipe(Effect.catch(refusedFrom("not-restored")))).find(
      (entry) => entry.id === id.value,
    );
    if (environment === undefined) return yield* refused("environment-missing");
    if (environment.status === "archived") {
      yield* operations.restore({ id: id.value }).pipe(Effect.catch(refusedFrom("not-restored")));
    }
    const target = { xwingEnvironmentId: id.value, workspaceRoot: input.workspaceRoot };
    const { branch } = input;
    const recovered = yield* resolve(target).pipe(
      Effect.catch((unavailable) =>
        (unavailable.reason === "repository-missing" ||
          unavailable.reason === "checkout-missing") &&
        branch !== null
          ? operations
              .attachRepository({ id: id.value, sourcePath: input.repositorySource, branch })
              .pipe(Effect.andThen(resolve(target)), Effect.catch(refusedFrom("not-restored")))
          : refusedFrom(
              unavailable.reason === "environment-missing" ? "environment-missing" : "not-restored",
            )(unavailable),
      ),
    );
    if (path.resolve(recovered.checkoutPath) !== path.resolve(input.checkoutPath)) {
      return yield* refused("checkout-moved");
    }
  });

  return DevelopmentEnvironmentCheckouts.of({ resolve, list, recover });
});

/** Resolves checkouts through this machine's Xwing CLI. */
export const layerXwing = Layer.effect(DevelopmentEnvironmentCheckouts, makeXwing);

/**
 * Refuses native Git removal of any checkout a thread used through Xwing. Paths compare after
 * resolving symlinks, so an alias of a recorded checkout is still Xwing's.
 */
export const makeRemovalOwnership = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isWindows = yield* HostProcess.isWindows;
  const identity = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.orElseSucceed(() => path.resolve(target)),
      Effect.map((resolved) => (isWindows ? resolved.toLowerCase() : resolved)),
    );
  const owner = "an Xwing development environment";
  return {
    ownerOf: Effect.fn("DevelopmentEnvironmentCheckouts.ownerOf")(
      function* (worktreePath: string) {
        const rows = yield* sql<{ readonly checkoutPath: string }>`
          SELECT DISTINCT checkout_path AS "checkoutPath"
          FROM orchestration_v2_projection_development_environment_usage
        `;
        if (rows.length === 0) return null;
        const target = yield* identity(worktreePath);
        for (const row of rows) {
          if ((yield* identity(row.checkoutPath)) === target) return owner;
        }
        return null;
      },
      // A failed lookup cannot show that T3 may remove the checkout.
      Effect.orElseSucceed(() => owner),
    ),
  } satisfies WorktreeOwnership;
});

export const layerRemovalOwnership = Layer.effect(WorktreeRemovalOwnership, makeRemovalOwnership);
