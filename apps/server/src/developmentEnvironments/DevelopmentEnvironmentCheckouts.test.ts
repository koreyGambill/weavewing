import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  XwingEnvironmentId,
  XwingEnvironmentNotFoundError,
  type XwingEnvironmentDetail,
  type XwingEnvironmentSummary,
  type XwingRepositoryDetail,
  type XwingRepositorySummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as XwingEnvironments from "../xwing/XwingEnvironments.ts";
import * as XwingOperations from "../xwing/XwingOperations.ts";
import * as DevelopmentEnvironmentCheckouts from "./DevelopmentEnvironmentCheckouts.ts";

const environmentId = XwingEnvironmentId.make("0123abcd");

const repository = (sourcePath: string, path: string): XwingRepositoryDetail => ({
  name: "repo",
  sourcePath,
  path,
  branch: "feature/env",
  base: "main",
  ahead: 0,
  behind: 0,
  dirty: false,
  published: false,
  stale: false,
});

const environment = (
  repositories: ReadonlyArray<XwingRepositoryDetail>,
): XwingEnvironmentDetail => ({
  id: environmentId,
  number: 12,
  name: "checkout work",
  rootPath: "/xwing/envs/12",
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
  repositories,
  health: { status: "ok", checks: [] },
  applications: { runs: [], truncated: false },
  agentSessions: [],
});

const resolveWith = (
  inspect: XwingEnvironments.XwingEnvironments["Service"]["inspect"],
  input: {
    readonly xwingEnvironmentId: string;
    readonly workspaceRoot: string;
  },
) =>
  Effect.gen(function* () {
    const checkouts = yield* DevelopmentEnvironmentCheckouts.DevelopmentEnvironmentCheckouts;
    return yield* checkouts.resolve(input);
  }).pipe(
    Effect.provide(
      DevelopmentEnvironmentCheckouts.layerXwing.pipe(
        Layer.provide(Layer.mock(XwingEnvironments.XwingEnvironments)({ inspect })),
        Layer.provide(Layer.mock(XwingOperations.XwingOperations)({})),
      ),
    ),
  );

it.effect("resolves only the environment's checkout of the thread's own repository", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-xwing-checkout-",
      }),
    );
    const project = `${root}/project`;
    const projectLink = `${root}/project-link`;
    const checkout = `${root}/envs/12/project`;
    yield* fileSystem.makeDirectory(project);
    yield* fileSystem.makeDirectory(checkout, { recursive: true });
    yield* fileSystem.symlink(project, projectLink);
    const withRepositories = (repositories: ReadonlyArray<XwingRepositoryDetail>) => () =>
      Effect.succeed(environment(repositories));

    const resolved = yield* resolveWith(
      withRepositories([
        repository(`${root}/other`, `${root}/envs/12/other`),
        repository(projectLink, checkout),
      ]),
      { xwingEnvironmentId: environmentId, workspaceRoot: project },
    );
    assert.deepEqual(resolved, {
      xwingEnvironmentId: environmentId,
      repositorySource: projectLink,
      checkoutPath: checkout,
      number: 12,
      name: "checkout work",
      branch: "feature/env",
    });

    const failures = yield* Effect.forEach(
      [
        [withRepositories([repository(`${root}/other`, checkout)]), environmentId],
        [withRepositories([repository(project, `${root}/envs/12/removed`)]), environmentId],
        [() => Effect.fail(new XwingEnvironmentNotFoundError({ environmentId })), environmentId],
        [() => Effect.die("a malformed id never reaches Xwing"), "../../etc"],
      ] as const,
      ([inspect, xwingEnvironmentId]) =>
        resolveWith(inspect, {
          xwingEnvironmentId,
          workspaceRoot: project,
        }).pipe(Effect.flip),
    );
    assert.deepEqual(
      failures.map((failure) => failure.reason),
      ["repository-missing", "checkout-missing", "environment-missing", "environment-missing"],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "xwing-checkout-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("matches the project's Git repository and keeps its folder within the checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-xwing-identity-" }),
    );
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({
        operation: "test",
        cwd,
        args: ["-c", "user.name=T3", "-c", "user.email=t3@example.com", ...args],
      });
    const initRepository = Effect.fn("test.initRepository")(function* (repo: string) {
      yield* fileSystem.makeDirectory(`${repo}/apps/server`, { recursive: true });
      yield* fileSystem.writeFileString(`${repo}/apps/server/index.ts`, "export {};\n");
      yield* run(repo, ["init", "--initial-branch=main"]);
      yield* run(repo, ["add", "."]);
      yield* run(repo, ["commit", "-m", "initial"]);
    });
    const source = `${root}/source/repo`;
    const unrelated = `${root}/unrelated/repo`;
    yield* initRepository(source);
    yield* initRepository(unrelated);
    const sibling = `${root}/sibling-worktree`;
    yield* run(source, ["worktree", "add", "-b", "sibling", sibling]);
    const checkout = `${root}/envs/12/repo`;
    yield* run(source, ["worktree", "add", "-b", "env-12", checkout]);
    const inEnvironment = (sourcePath: string) => () =>
      Effect.succeed(environment([repository(sourcePath, checkout)]));
    const resolve = (sourcePath: string, workspaceRoot: string) =>
      resolveWith(inEnvironment(sourcePath), { xwingEnvironmentId: environmentId, workspaceRoot });

    assert.equal(
      (yield* resolve(source, `${source}/apps/server`)).checkoutPath,
      `${checkout}/apps/server`,
    );
    assert.equal((yield* resolve(source, sibling)).checkoutPath, checkout);
    assert.equal((yield* resolve(source, source)).checkoutPath, checkout);
    assert.equal(
      (yield* resolve(unrelated, source).pipe(Effect.flip)).reason,
      "repository-missing",
    );
    yield* fileSystem.remove(`${checkout}/apps`, { recursive: true });
    assert.equal(
      (yield* resolve(source, `${source}/apps/server`).pipe(Effect.flip)).reason,
      "checkout-missing",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "xwing-identity-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("lists active present checkouts of the project's repository from the catalog alone", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-xwing-list-" }),
    );
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({
        operation: "test",
        cwd,
        args: ["-c", "user.name=T3", "-c", "user.email=t3@example.com", ...args],
      });
    const initRepository = Effect.fn("test.initRepository")(function* (repo: string) {
      yield* fileSystem.makeDirectory(`${repo}/apps/server`, { recursive: true });
      yield* fileSystem.writeFileString(`${repo}/apps/server/index.ts`, "export {};\n");
      yield* run(repo, ["init", "--initial-branch=main"]);
      yield* run(repo, ["add", "."]);
      yield* run(repo, ["commit", "-m", "initial"]);
    });
    const source = `${root}/source/repo`;
    const unrelated = `${root}/unrelated/repo`;
    yield* initRepository(source);
    yield* initRepository(unrelated);
    const alias = `${root}/alias`;
    yield* fileSystem.symlink(source, alias);
    const sibling = `${root}/sibling`;
    yield* run(source, ["worktree", "add", "-b", "sibling", sibling]);
    const worktree = (name: string) =>
      Effect.as(run(source, ["worktree", "add", "-b", name, `${root}/envs/${name}`]), {
        name: "repo",
        sourcePath: source,
        path: `${root}/envs/${name}`,
        branch: name,
        present: true,
      });
    const viaAlias = { ...(yield* worktree("alias")), sourcePath: alias };
    const viaSibling = { ...(yield* worktree("from-sibling")), sourcePath: sibling };
    const plain = yield* worktree("plain");
    const summary = (
      id: string,
      number: number,
      status: "active" | "archived",
      repositories: ReadonlyArray<XwingRepositorySummary>,
    ): XwingEnvironmentSummary => ({
      id: XwingEnvironmentId.make(id),
      number,
      name: `env ${number}`,
      status,
      rootPath: `${root}/envs`,
      createdAt: "2026-11-07T00:00:00Z",
      updatedAt: "2026-11-07T00:00:00Z",
      repositories,
    });
    const catalog = [
      summary("aaaaaaaa", 1, "active", [
        viaAlias,
        { ...plain, name: "other", sourcePath: unrelated, path: `${root}/envs/other` },
      ]),
      summary("bbbbbbbb", 2, "active", [viaSibling]),
      summary("cccccccc", 3, "archived", [plain]),
      summary("dddddddd", 4, "active", [{ ...plain, present: false }]),
    ];
    const list = (workspaceRoot: string) =>
      Effect.flatMap(DevelopmentEnvironmentCheckouts.DevelopmentEnvironmentCheckouts, (checkouts) =>
        checkouts.list({ workspaceRoot }),
      ).pipe(
        Effect.provide(
          DevelopmentEnvironmentCheckouts.layerXwing.pipe(
            Layer.provide(
              Layer.mock(XwingEnvironments.XwingEnvironments)({
                list: () => Effect.succeed(catalog),
                inspect: () => Effect.die("listing never inspects an environment"),
              }),
            ),
            Layer.provide(Layer.mock(XwingOperations.XwingOperations)({})),
          ),
        ),
      );

    assert.deepEqual(
      (yield* list(`${source}/apps/server`)).map((choice) => [
        choice.xwingEnvironmentId,
        choice.checkoutPath,
        choice.branch,
      ]),
      [
        ["aaaaaaaa", `${root}/envs/alias/apps/server`, "alias"],
        ["bbbbbbbb", `${root}/envs/from-sibling/apps/server`, "from-sibling"],
      ],
    );
    assert.deepEqual(
      (yield* list(unrelated)).map((choice) => choice.checkoutPath),
      [`${root}/envs/other`],
    );
    yield* fileSystem.remove(`${root}/envs/alias/apps`, { recursive: true });
    assert.deepEqual(
      (yield* list(`${source}/apps/server`)).map((choice) => choice.xwingEnvironmentId),
      ["bbbbbbbb"],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "xwing-list-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect.each([
  {
    label: "restores an archived environment",
    status: "archived",
    attached: true,
    calls: ["restore"],
  },
  {
    label: "re-adds the thread's branch to an active environment missing the repository",
    status: "active",
    attached: false,
    calls: ["attach repo feature/env"],
  },
  {
    label: "refuses when Xwing leaves a listed checkout missing",
    status: "active",
    attached: true,
    calls: ["attach repo feature/env"],
    refused: "not-restored",
  },
  {
    label: "refuses a deleted environment without touching Xwing",
    status: "absent",
    attached: true,
    calls: [],
    refused: "environment-missing",
  },
  {
    label: "refuses a checkout Xwing restores at another path",
    status: "archived",
    attached: true,
    restoredRoot: "envs/13",
    calls: ["restore"],
    refused: "checkout-moved",
  },
  {
    label: "refuses an active environment it cannot re-add without a branch",
    status: "active",
    attached: false,
    branch: null,
    calls: [],
    refused: "not-restored",
  },
] as const)("recover $label", (row) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-xwing-recover-" }),
    );
    const project = `${root}/project`;
    yield* fileSystem.makeDirectory(project);
    const checkoutPath = `${root}/envs/12/repo`;
    const branch = "branch" in row ? row.branch : "feature/env";
    const calls: Array<string> = [];
    let status: "active" | "archived" | "absent" = row.status;
    let repositories = row.attached ? [{ path: checkoutPath, branch: "feature/env" }] : [];
    const restoredPath = "restoredRoot" in row ? `${root}/${row.restoredRoot}/repo` : checkoutPath;
    const summary = (): XwingEnvironmentSummary => ({
      id: environmentId,
      number: 12,
      name: "checkout work",
      status: status === "archived" ? "archived" : "active",
      rootPath: `${root}/envs/12`,
      createdAt: "2026-11-07T00:00:00Z",
      updatedAt: "2026-11-07T00:00:00Z",
      repositories: repositories.map((entry) => ({
        name: "repo",
        sourcePath: project,
        path: entry.path,
        branch: entry.branch,
        present: false,
      })),
    });
    const recover = Effect.flatMap(
      DevelopmentEnvironmentCheckouts.DevelopmentEnvironmentCheckouts,
      (checkouts) =>
        checkouts.recover({
          xwingEnvironmentId: environmentId,
          repositorySource: project,
          workspaceRoot: project,
          checkoutPath,
          branch,
        }),
    ).pipe(
      Effect.provide(
        DevelopmentEnvironmentCheckouts.layerXwing.pipe(
          Layer.provide(
            Layer.mock(XwingEnvironments.XwingEnvironments)({
              list: () => Effect.succeed(status === "absent" ? [] : [summary()]),
              inspect: () =>
                status === "active"
                  ? Effect.succeed(
                      environment(repositories.map((entry) => repository(project, entry.path))),
                    )
                  : Effect.fail(new XwingEnvironmentNotFoundError({ environmentId })),
            }),
          ),
          Layer.provide(
            Layer.mock(XwingOperations.XwingOperations)({
              restore: () =>
                Effect.gen(function* () {
                  calls.push("restore");
                  status = "active";
                  repositories = repositories.map((entry) => ({ ...entry, path: restoredPath }));
                  yield* fileSystem
                    .makeDirectory(restoredPath, { recursive: true })
                    .pipe(Effect.orDie);
                  return { environmentId, outcome: "restored", rootPath: `${root}/envs/12` };
                }),
              attachRepository: (input) =>
                Effect.gen(function* () {
                  calls.push(
                    `attach ${input.sourcePath === project ? "repo" : input.sourcePath} ${input.branch}`,
                  );
                  // Xwing refreshes a repository it already lists and leaves a deleted worktree missing.
                  if (repositories.length > 0) return {} as never;
                  repositories = [{ path: checkoutPath, branch: input.branch }];
                  yield* fileSystem
                    .makeDirectory(checkoutPath, { recursive: true })
                    .pipe(Effect.orDie);
                  return {} as never;
                }),
            }),
          ),
        ),
      ),
    );

    const result = yield* Effect.result(recover);
    assert.deepEqual(calls, [...row.calls]);
    if (!("refused" in row)) {
      assert.isTrue(Result.isSuccess(result));
      assert.isTrue(yield* fileSystem.exists(checkoutPath));
      return;
    }
    assert.isTrue(Result.isFailure(result));
    if (Result.isSuccess(result)) return;
    const failure = result.failure;
    assert.equal(failure.reason, row.refused);
    assert.include(failure.message, "the thread was not moved");
    if (branch !== null) assert.include(failure.message, `'${branch}'`);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "xwing-recover-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
