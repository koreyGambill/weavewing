import type {
  SourceControlFileLink,
  SourceControlFileLinkInput,
  SourceControlFileLinkRefChoice,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { isNetworkPath } from "@t3tools/shared/path";

import * as ProcessRunner from "../processRunner.ts";
import { localRepositoryIdentity } from "../project/RepositoryIdentityResolver.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import { localRealPath } from "../workspace/localRealPath.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { toWslDrivePath } from "../workspace/wslDrivePath.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

export class SourceControlFileLinks extends Context.Service<
  SourceControlFileLinks,
  {
    /** Reads only refs already fetched, so it never waits on the network. */
    readonly fileLink: (input: SourceControlFileLinkInput) => Effect.Effect<SourceControlFileLink>;
  }
>()("t3/sourceControl/SourceControlFileLinks") {}

const GIT_PROBE_TIMEOUT = "2 seconds";
// No transport on any git version, so a partial clone cannot fetch what a probe reads, and paths
// such as `:README.md` stay paths.
const GIT_OFFLINE_OPTIONS = ["-c", "protocol.allow=never", "--literal-pathspecs"];

/** Default branch when the file is there; else the branch's upstream; else default anyway. */
function chooseFileLinkRef(facts: {
  readonly defaultBranch: string | null;
  readonly existsOnDefault: boolean;
  readonly upstreamBranch: string | null;
}): { readonly ref: string; readonly choice: SourceControlFileLinkRefChoice } | null {
  if (facts.defaultBranch !== null && facts.existsOnDefault)
    return { ref: facts.defaultBranch, choice: "default" };
  if (facts.upstreamBranch !== null) return { ref: facts.upstreamBranch, choice: "current" };
  if (facts.defaultBranch !== null)
    return { ref: facts.defaultBranch, choice: "default-without-upstream" };
  return null;
}

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const env = {
    ...unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform),
    GIT_NO_LAZY_FETCH: "1",
    // An empty allowlist overrides any `protocol.<name>.allow`, which `protocol.allow` does not.
    GIT_ALLOW_PROTOCOL: "",
  };

  /**
   * The real path the file reader would read, or why there is none. A relative path stays
   * inside its workspace, and no network path is touched, even through a link.
   */
  const resolveFile = Effect.fn("SourceControlFileLinks.resolveFile")(function* (
    input: SourceControlFileLinkInput,
  ) {
    const hostPath =
      input.path.startsWith("~/") || input.path.startsWith("~\\")
        ? expandHomePath(input.path, yield* HostProcess.HomeDirectory)
        : yield* toWslDrivePath(input.path).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
    if (isNetworkPath(hostPath) || (input.cwd !== undefined && isNetworkPath(input.cwd))) {
      return { unavailable: "network-path" } as const;
    }
    const realPath = (value: string) => Effect.promise(() => localRealPath(value));
    if (path.isAbsolute(hostPath)) {
      const real = yield* realPath(hostPath);
      return real === null ? ({ unavailable: "network-path" } as const) : { real };
    }
    if (input.cwd === undefined) return { unavailable: "outside-workspace" } as const;
    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: input.cwd, relativePath: input.path })
      .pipe(Effect.option);
    if (target._tag === "None") return { unavailable: "outside-workspace" } as const;
    const [realRoot, real] = yield* Effect.all([
      realPath(path.resolve(input.cwd)),
      realPath(target.value.absolutePath),
    ]);
    if (realRoot === null || real === null) return { unavailable: "network-path" } as const;
    const relative = path.relative(realRoot, real);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? ({ unavailable: "outside-workspace" } as const)
      : { real };
  });

  const fileLink: SourceControlFileLinks["Service"]["fileLink"] = Effect.fn(
    "SourceControlFileLinks.fileLink",
  )(function* (input) {
    const file = yield* resolveFile(input);
    if (file.unavailable !== undefined) {
      return { _tag: "Unavailable", reason: file.unavailable } as const;
    }
    const directory = path.dirname(file.real);
    // Null when git exits non-zero, times out or cannot start: every probe is optional.
    const git = (args: ReadonlyArray<string>) =>
      processRunner
        .run({
          command: "git",
          args: ["-C", directory, ...GIT_OFFLINE_OPTIONS, ...args],
          env,
          timeout: GIT_PROBE_TIMEOUT,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((result) =>
            result.code === 0 && !result.timedOut ? result.stdout.replace(/\r?\n$/u, "") : null,
          ),
          Effect.orElseSucceed(() => null),
        );
    // `git config` as written, so no forge CLI runs and `insteadOf` cannot change the forge.
    const [location, remoteConfig] = yield* Effect.all(
      [
        git(["rev-parse", "--show-toplevel", "--show-prefix"]),
        git(["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"]),
      ],
      { concurrency: "unbounded" },
    );
    if (location === null) return { _tag: "Unavailable", reason: "not-repository" } as const;
    const [rootPath = "", prefix = ""] = location.split("\n");
    const identity = localRepositoryIdentity(remoteConfig ?? "", rootPath);
    if (identity === null) return { _tag: "Unavailable", reason: "not-repository" } as const;
    const [host = "", ...repositoryPath] = identity.canonicalKey.split("/");
    const definition =
      identity.provider === undefined
        ? undefined
        : sourceControlDefinitions.find(identity.provider);
    const buildFileUrl = definition?.fileUrl;
    if (definition === undefined || buildFileUrl === undefined) {
      return { _tag: "Unavailable", reason: "unsupported-host", host } as const;
    }

    const refExists = (ref: string) =>
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
        Effect.map((sha) => sha !== null),
      );
    const remote = identity.locator.remoteName;
    const remoteBranchPrefix = `refs/remotes/${remote}/`;
    const [headRef, remoteHead] = yield* Effect.all(
      [
        git(["symbolic-ref", "-q", "HEAD"]),
        git(["symbolic-ref", "-q", `${remoteBranchPrefix}HEAD`]),
      ],
      { concurrency: "unbounded" },
    );
    const repoPath = `${prefix}${path.basename(file.real)}`;

    // A remote HEAD can name a branch the remote renamed and a prune removed, and clones made
    // without one still fetch `main`, so each candidate must exist locally.
    let defaultBranch: string | null = null;
    for (const candidate of [
      remoteHead?.startsWith(remoteBranchPrefix) === true
        ? remoteHead.slice(remoteBranchPrefix.length)
        : null,
      "main",
      "master",
    ]) {
      if (candidate !== null && (yield* refExists(`${remoteBranchPrefix}${candidate}`))) {
        defaultBranch = candidate;
        break;
      }
    }
    const branch = headRef?.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : null;
    const upstream =
      headRef === null
        ? null
        : yield* git([
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
            headRef,
          ]);
    const [upstreamRemote, upstreamRef = "", trackingRef = ""] = upstream?.split("\0") ?? [];
    // A branch whose upstream was deleted on the remote keeps its config but loses its ref.
    const upstreamBranch =
      upstreamRemote === remote &&
      upstreamRef.startsWith("refs/heads/") &&
      trackingRef !== "" &&
      (yield* refExists(trackingRef))
        ? upstreamRef.slice("refs/heads/".length)
        : null;
    // Lists the tree entry, so a partial clone needs no blob to answer.
    const existsOnDefault =
      defaultBranch !== null &&
      ((yield* git([
        "ls-tree",
        "--full-tree",
        "--name-only",
        `${remoteBranchPrefix}${defaultBranch}`,
        "--",
        repoPath,
      ])) ?? "") !== "";

    const target = (ref: string | null) => {
      if (ref === null) return null;
      const url = buildFileUrl({
        host,
        repository: repositoryPath.join("/"),
        remoteUrl: identity.locator.remoteUrl.trim(),
        ...(identity.webUrl === undefined ? {} : { webUrl: identity.webUrl }),
        ref,
        path: repoPath,
        line: input.line,
        endLine: input.endLine,
      });
      return url === null ? null : { ref, url };
    };
    const chosen = chooseFileLinkRef({ defaultBranch, existsOnDefault, upstreamBranch });
    const link = chosen === null ? null : target(chosen.ref);
    if (chosen === null || link === null) {
      return { _tag: "Unavailable", reason: "no-branch" } as const;
    }
    return {
      _tag: "Available",
      provider: definition.kind,
      providerLabel: definition.label,
      remoteName: remote,
      choice: chosen.choice,
      branch,
      link,
      defaultBranch: target(defaultBranch),
      currentBranch: target(upstreamBranch),
    } as const;
  });

  return SourceControlFileLinks.of({ fileLink });
});

export const layer = Layer.effect(SourceControlFileLinks, make);
