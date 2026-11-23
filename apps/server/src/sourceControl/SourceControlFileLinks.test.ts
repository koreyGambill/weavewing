import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
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
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

/** The real runner, noting every command the service starts. */
const recordingLinks = (commands: Array<string>) =>
  SourceControlFileLinks.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(
      Layer.effect(
        ProcessRunner.ProcessRunner,
        Effect.map(ProcessRunner.make(), (runner) =>
          ProcessRunner.ProcessRunner.of({
            ...runner,
            run: (input) => {
              commands.push(input.command);
              return runner.run(input);
            },
          }),
        ),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const objectCount = (cwd: string) =>
  git(cwd, ["count-objects", "-v"]).pipe(
    Effect.map((result) =>
      result.stdout
        .split("\n")
        .filter((line) => /^(count|in-pack):/u.test(line))
        .reduce((sum, line) => sum + Number(line.split(":")[1]), 0),
    ),
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
        branch: "feature/x",
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
  it.effect("finds a workspace-relative path inside its workspace", () =>
    Effect.gen(function* () {
      const { cwd } = yield* makeCheckout;
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ cwd, path: "src/a.ts" })).toMatchObject({
        choice: "default",
        link: { url: "https://github.com/acme/app/blob/main/src/a.ts" },
      });
    }),
  );

  it.effect("refuses relative paths that leave the workspace, by name or through a link", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* makeCheckout;
      const sibling = yield* makeCheckout;
      yield* fileSystem.symlink(path.join(sibling.cwd, "src"), path.join(cwd, "elsewhere"));
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      const outside = { _tag: "Unavailable", reason: "outside-workspace" };
      expect(
        yield* links.fileLink({ cwd, path: `../${path.basename(sibling.cwd)}/src/a.ts` }),
      ).toEqual(outside);
      expect(yield* links.fileLink({ cwd, path: "elsewhere/a.ts" })).toEqual(outside);
      expect(yield* links.fileLink({ path: "src/a.ts" })).toEqual(outside);
    }),
  );

  it.effect("never follows a network path, named or reached through a parent link", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* makeCheckout;
      yield* fileSystem.symlink("//fileserver/share", path.join(cwd, "share"));
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      const network = { _tag: "Unavailable", reason: "network-path" };
      expect(yield* links.fileLink({ path: "//fileserver/share/a.ts" })).toEqual(network);
      expect(yield* links.fileLink({ path: path.join(cwd, "share", "a.ts") })).toEqual(network);
      expect(yield* links.fileLink({ cwd, path: "share/a.ts" })).toEqual(network);
    }),
  );

  it.effect("skips a remote HEAD whose branch was renamed and pruned", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout;
      yield* git(cwd, ["update-ref", "refs/remotes/origin/master", "refs/remotes/origin/main"]);
      yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"]);
      yield* git(cwd, ["update-ref", "-d", "refs/remotes/origin/master"]);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: file("a.ts") })).toMatchObject({
        choice: "default",
        link: { ref: "main" },
      });
    }),
  );

  it.effect("treats an upstream the remote deleted as no upstream", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout;
      yield* publishBranch(cwd);
      yield* git(cwd, ["update-ref", "-d", "refs/remotes/origin/feature/x"]);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: file("new.ts") })).toMatchObject({
        choice: "default-without-upstream",
        branch: "feature/x",
        currentBranch: null,
      });
    }),
  );

  it.effect("reports a detached HEAD apart from a branch without an upstream", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout;
      yield* git(cwd, ["switch", "--detach"]);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: file("new.ts") })).toMatchObject({
        choice: "default-without-upstream",
        branch: null,
      });
    }),
  );

  it.effect("reads a treeless clone with a reachable remote without fetching", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd: source } = yield* makeCheckout;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-file-links-treeless-" });
      const bare = path.join(root, "remote.git");
      const clone = path.join(root, "clone");
      yield* git(root, ["clone", "--bare", "--branch", "main", source, bare]);
      yield* git(bare, ["config", "uploadpack.allowFilter", "true"]);
      yield* git(root, ["clone", "--filter=tree:0", "--no-checkout", `file://${bare}`, clone]);
      // The forge spelling for recognition, still fetching from the local remote.
      yield* git(clone, ["remote", "set-url", "origin", "git@github.com:acme/app.git"]);
      yield* git(clone, ["config", `url.file://${bare}.insteadOf`, "git@github.com:acme/app.git"]);
      // Outranks `protocol.allow=never`, so only the environment's allowlist keeps it closed.
      yield* git(clone, ["config", "protocol.file.allow", "always"]);
      yield* fileSystem.makeDirectory(path.join(clone, "src"));
      yield* fileSystem.writeFileString(path.join(clone, "src", "a.ts"), "a\n");
      const before = yield* objectCount(clone);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: path.join(clone, "src", "a.ts") })).toMatchObject({
        _tag: "Available",
        link: { ref: "main" },
      });
      expect(yield* objectCount(clone)).toBe(before);
      // Plain git does fetch the trees, so the remote was reachable all along.
      yield* git(clone, ["ls-tree", "-r", "origin/main"]);
      expect(yield* objectCount(clone)).toBeGreaterThan(before);
    }),
  );

  it.effect("reads a path that looks like pathspec magic literally", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* makeCheckout;
      yield* git(cwd, ["switch", "main"]);
      yield* fileSystem.writeFileString(path.join(cwd, ":README.md"), "magic\n");
      yield* git(cwd, ["add", "--", ":(literal):README.md"]);
      yield* git(cwd, ["commit", "-m", "magic"]);
      yield* git(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      const links = yield* SourceControlFileLinks.SourceControlFileLinks;
      expect(yield* links.fileLink({ path: path.join(cwd, ":README.md") })).toMatchObject({
        choice: "default",
        link: { url: "https://github.com/acme/app/blob/main/%3AREADME.md" },
      });
    }),
  );
});

it.layer(NodeServices.layer)("SourceControlFileLinks forge contact", (it) => {
  it.effect("names the forge from git config alone, starting no forge CLI", () =>
    Effect.gen(function* () {
      const { cwd, file } = yield* makeCheckout.pipe(Effect.provide(ProcessRunner.layer));
      yield* git(cwd, ["remote", "set-url", "origin", "git@gitlab.com:acme/app.git"]).pipe(
        Effect.provide(ProcessRunner.layer),
      );
      const commands: Array<string> = [];
      const link = yield* Effect.gen(function* () {
        const links = yield* SourceControlFileLinks.SourceControlFileLinks;
        return yield* links.fileLink({ path: file("a.ts") });
      }).pipe(Effect.provide(recordingLinks(commands)));
      expect(link).toMatchObject({
        providerLabel: "GitLab",
        link: { url: "https://gitlab.com/acme/app/-/blob/main/src/a.ts" },
      });
      expect(new Set(commands)).toEqual(new Set(["git"]));
    }),
  );
});
