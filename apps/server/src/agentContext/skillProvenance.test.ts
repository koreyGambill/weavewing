import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { describeSkills, type SkillCandidate } from "./skillProvenance.ts";

const skillFile = (fs: FileSystem.FileSystem, dir: string, text = "---\nname: x\n---\n") =>
  fs
    .makeDirectory(dir, { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(`${dir}/SKILL.md`, text)));

const candidate = (
  name: string,
  path: string,
  extra: Partial<SkillCandidate> & { description?: string; userInvocationOnly?: boolean } = {},
): SkillCandidate => ({
  skill: {
    name,
    path,
    enabled: true,
    ...(extra.description ? { description: extra.description } : {}),
    ...(extra.userInvocationOnly ? { userInvocationOnly: true } : {}),
  },
  shadowed: extra.shadowed ?? false,
  ...(extra.plugin ? { plugin: extra.plugin } : {}),
});

it.effect("names each skill's origin, resolves links, prices listings and pairs duplicates", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "skills-" }));
    const config = path.join(home, ".claude");
    const project = path.join(home, "code", "app");
    const shared = path.join(home, "code", "agent-resources", "skills");

    yield* skillFile(fs, path.join(config, "skills", "tdd"));
    yield* skillFile(fs, path.join(shared, "review"));
    yield* fs.makeDirectory(path.join(config, "skills"), { recursive: true });
    yield* fs.symlink(path.join(shared, "review"), path.join(config, "skills", "review"));
    yield* skillFile(fs, path.join(home, ".agents", "skills", "ask"));
    yield* fs.symlink(
      path.join(home, ".agents", "skills", "ask"),
      path.join(config, "skills", "ask"),
    );
    yield* fs.writeFileString(
      path.join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({ version: 3, skills: { ask: { source: "mattpocock/skills" } } }),
    );
    const plugin = path.join(config, "plugins", "cache", "official", "mp", "1.3.1", "skills");
    yield* skillFile(fs, path.join(plugin, "tdd"));
    yield* skillFile(fs, path.join(project, ".claude", "skills", "tdd"));
    yield* skillFile(fs, path.join(project, ".claude", "skills", "deploy"));

    const rows = yield* describeSkills(
      [
        candidate("ask", path.join(config, "skills", "ask", "SKILL.md")),
        candidate("deploy", path.join(project, ".claude", "skills", "deploy", "SKILL.md"), {
          userInvocationOnly: true,
        }),
        candidate("mattpocock-skills:tdd", path.join(plugin, "tdd", "SKILL.md"), {
          plugin: { name: "mattpocock-skills", version: "1.3.1" },
          description: "Test first.",
        }),
        candidate("review", path.join(config, "skills", "review", "SKILL.md"), {
          description: "Réview",
        }),
        candidate("tdd", path.join(config, "skills", "tdd", "SKILL.md"), {
          description: "Test first.",
        }),
        candidate("tdd", path.join(project, ".claude", "skills", "tdd", "SKILL.md"), {
          shadowed: true,
        }),
      ],
      { driver: "claudeAgent", home, configDir: config, cwd: project },
    );
    const row = (name: string, shadowed = false) =>
      rows.find((entry) => entry.name === name && entry.shadowed === shadowed)!;

    expect(row("ask")).toMatchObject({
      origin: { kind: "npx", label: "npx skills", detail: "mattpocock/skills" },
      realPath: path.join(home, ".agents", "skills", "ask", "SKILL.md"),
      linked: true,
    });
    expect(row("review")).toMatchObject({
      origin: { kind: "user", label: "User skills" },
      realPath: path.join(shared, "review", "SKILL.md"),
      linked: true,
      // "- review: Réview\n" is 18 UTF-8 bytes.
      listingBytes: 18,
      listingTokens: 5,
      duplicates: [],
    });
    expect(row("tdd")).toMatchObject({
      origin: { kind: "user" },
      linked: false,
      listed: true,
      duplicates: ["mattpocock-skills@1.3.1", "Project skills"],
    });
    expect(row("mattpocock-skills:tdd")).toMatchObject({
      baseName: "tdd",
      origin: { kind: "plugin", label: "mattpocock-skills@1.3.1" },
      duplicates: ["User skills", "Project skills"],
    });
    expect(row("tdd", true)).toMatchObject({
      origin: { kind: "project", label: "Project skills" },
      listed: false,
      listingBytes: 0,
    });
    expect(row("deploy")).toMatchObject({ listed: false, listingBytes: 0, duplicates: [] });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("labels Codex's own skills and lists their file path in the listing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "codex-skills-" }));
    const codexHome = path.join(home, ".codex");
    yield* skillFile(fs, path.join(codexHome, "skills", "plan"));
    yield* skillFile(fs, path.join(codexHome, "skills", ".system", "imagegen"));
    const shared = path.join(home, "code", "dotfiles", "skills", "capture");
    yield* skillFile(fs, shared);
    yield* fs.symlink(shared, path.join(codexHome, "skills", "capture"));
    const file = path.join(codexHome, "skills", "plan", "SKILL.md");
    const [plan, system, capture] = yield* describeSkills(
      [
        candidate("plan", file, { description: "Plan." }),
        candidate("imagegen", path.join(codexHome, "skills", ".system", "imagegen", "SKILL.md")),
        // Codex reports a linked skill at the path the link resolves to.
        candidate("capture", path.join(shared, "SKILL.md")),
      ],
      { driver: "codex", home, configDir: codexHome, cwd: null },
    );
    expect(capture).toMatchObject({
      path: path.join(codexHome, "skills", "capture", "SKILL.md"),
      realPath: path.join(shared, "SKILL.md"),
      linked: true,
      origin: { kind: "codex", label: "Codex skills" },
    });
    expect(plan).toMatchObject({
      origin: { kind: "codex", label: "Codex skills" },
      listingBytes: Buffer.byteLength(`- plan: Plan. (file: ${file})\n`),
    });
    expect(system?.origin).toEqual({ kind: "codex", label: "Codex system skills" });
  }).pipe(Effect.provide(NodeServices.layer)),
);
