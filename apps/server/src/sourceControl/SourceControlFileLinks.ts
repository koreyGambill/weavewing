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

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

export class SourceControlFileLinks extends Context.Service<
  SourceControlFileLinks,
  {
    /** Reads only refs already fetched, so it never waits on the network. */
    readonly fileLink: (input: SourceControlFileLinkInput) => Effect.Effect<SourceControlFileLink>;
  }
>()("t3/sourceControl/SourceControlFileLinks") {}

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
  const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const path = yield* Path.Path;
  const env = unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform);

  const fileLink: SourceControlFileLinks["Service"]["fileLink"] = Effect.fn(
    "SourceControlFileLinks.fileLink",
  )(function* (input) {
    const directory = path.dirname(input.path);
    const identity = yield* resolver.resolve(directory);
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

    // Null when git exits non-zero, times out or cannot start: every probe is optional.
    const git = (args: ReadonlyArray<string>) =>
      processRunner
        .run({
          command: "git",
          args: ["-C", directory, ...args],
          env,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((result) =>
            result.code === 0 && !result.timedOut ? result.stdout.replace(/\r?\n$/u, "") : null,
          ),
          Effect.orElseSucceed(() => null),
        );
    const remote = identity.locator.remoteName;
    const [prefix, headRef, remoteHead] = yield* Effect.all(
      [
        git(["rev-parse", "--show-prefix"]),
        git(["symbolic-ref", "-q", "HEAD"]),
        git(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`]),
      ],
      { concurrency: "unbounded" },
    );
    if (prefix === null) return { _tag: "Unavailable", reason: "not-repository" } as const;
    const repoPath = `${prefix}${path.basename(input.path)}`;

    const remoteBranchPrefix = `refs/remotes/${remote}/`;
    // Clones made without `origin/HEAD`, such as some worktree tools', still fetch `main`.
    const defaultBranch =
      remoteHead?.startsWith(remoteBranchPrefix) === true
        ? remoteHead.slice(remoteBranchPrefix.length)
        : ((yield* git([
            "for-each-ref",
            "--format=%(refname:lstrip=3)",
            `${remoteBranchPrefix}main`,
            `${remoteBranchPrefix}master`,
          ]))
            ?.split("\n")
            .find((name) => name === "main" || name === "master") ?? null);
    const upstream =
      headRef === null
        ? null
        : yield* git([
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)",
            headRef,
          ]);
    const [upstreamRemote, upstreamRef = ""] = upstream?.split("\0") ?? [];
    const upstreamBranch =
      upstreamRemote === remote && upstreamRef.startsWith("refs/heads/")
        ? upstreamRef.slice("refs/heads/".length)
        : null;
    const existsOnDefault =
      defaultBranch !== null &&
      (yield* git(["cat-file", "-e", `${remoteBranchPrefix}${defaultBranch}:${repoPath}`])) !==
        null;

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
      link,
      defaultBranch: target(defaultBranch),
      currentBranch: target(upstreamBranch),
    } as const;
  });

  return SourceControlFileLinks.of({ fileLink });
});

export const layer = Layer.effect(SourceControlFileLinks, make);
