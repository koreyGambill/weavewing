import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlFileLinks from "./SourceControlFileLinks.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, "-c", "user.name=T3", "-c", "user.email=t3@example.test", ...args],
    });
  });

/**
 * A checkout of github.com/acme/app whose `origin/main` holds `src/a.ts`, with refs written
 * locally in place of a fetch.
 */
const makeCheckout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-links-test-" });
  yield* fileSystem.makeDirectory(path.join(cwd, "src"));
  yield* fileSystem.writeFileString(path.join(cwd, "src", "a.ts"), "a\n");
  yield* git(cwd, ["init", "-b", "main"]);
  yield* git(cwd, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "init"]);
  yield* git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  yield* git(cwd, ["switch", "-c", "feature/x"]);
  yield* fileSystem.writeFileString(path.join(cwd, "src", "new.ts"), "new\n");
  return { cwd, file: (name: string) => path.join(cwd, "src", name) };
});

const publishBranch = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["update-ref", "refs/remotes/origin/feature/x", "HEAD"]);
    yield* git(cwd, ["config", "branch.feature/x.remote", "origin"]);
    yield* git(cwd, ["config", "branch.feature/x.merge", "refs/heads/feature/x"]);
  });

const layer = SourceControlFileLinks.layer.pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("SourceControlFileLinks", (it) => {
  it.effect("links the default branch when the file is already there, with its range", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout;
      yield* publishBranch(cwd);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: file("a.ts"), line: 57, endLine: 64 })).toEqual({
        _tag: "Available",
        provider: "github",
        providerLabel: "GitHub",
        remoteName: "origin",
        choice: "default",
        link: { ref: "main", url: "https://github.com/acme/app/blob/main/src/a.ts#L57-L64" },
        defaultBranch: {
          ref: "main",
          url: "https://github.com/acme/app/blob/main/src/a.ts#L57-L64",
        },
        currentBranch: {
          ref: "feature/x",
          url: "https://github.com/acme/app/blob/feature/x/src/a.ts#L57-L64",
        },
      });
    }),
  );

  it.effect("links the checked out branch's upstream when only that branch has the file", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout;
      yield* publishBranch(cwd);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      const link = yield* links.fileLink({ path: file("new.ts") });
      expect(link).toMatchObject({
        choice: "current",
        link: { ref: "feature/x", url: "https://github.com/acme/app/blob/feature/x/src/new.ts" },
      });
    }),
  );

  it.effect("falls back to the default branch when the branch has no upstream there", () =>
    Effect.gen(function* () {
      const { file } = yield* makeCheckout;
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: file("new.ts") })).toMatchObject({
        choice: "default-without-upstream",
        link: { ref: "main" },
        currentBranch: null,
      });
    }),
  );

  it.effect("finds the default branch of a remote that never recorded its HEAD", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout;
      yield* git(cwd, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: file("a.ts") })).toMatchObject({
        choice: "default",
        link: { ref: "main" },
      });
    }),
  );

  it.effect("reports a file outside any repository", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-links-plain-" });
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: path.join(cwd, "notes.md") })).toEqual({
        _tag: "Unavailable",
        reason: "not-repository",
      });
    }),
  );

  it.effect("names the host of a remote no forge links files on", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout;
      yield* git(cwd, ["remote", "set-url", "origin", "https://code.example.test/acme/app.git"]);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: file("a.ts") })).toEqual({
        _tag: "Unavailable",
        reason: "unsupported-host",
        host: "code.example.test",
      });
    }),
  );
});
