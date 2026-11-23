import type {
  AgentContextSkill,
  AgentContextSkillOrigin,
  ServerProviderSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface SkillCandidate {
  readonly skill: ServerProviderSkill;
  readonly shadowed: boolean;
  readonly plugin?: { readonly name: string; readonly version: string };
}

export interface SkillLocations {
  readonly driver: string;
  readonly home: string;
  /** The provider's config folder: Claude's config dir or Codex's home. */
  readonly configDir: string;
  readonly cwd: string | null;
}

/** A skill row before its repository is known. */
export type SkillRow = Omit<AgentContextSkill, "repoRoot" | "modified" | "editable">;

const SkillLock = Schema.fromJsonString(
  Schema.Struct({
    skills: Schema.Record(
      Schema.String,
      Schema.Struct({
        source: Schema.optional(Schema.String),
        sourceUrl: Schema.optional(Schema.String),
      }),
    ),
  }),
);

/** `npx skills` installs into ~/.agents/skills and records each skill's source in this lock. */
const readSkillLock = Effect.fn("SkillProvenance.readSkillLock")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* fs.readFileString(path.join(home, ".agents", ".skill-lock.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SkillLock)),
    Effect.orElseSucceed(() => ({ skills: {} })),
  );
  return new Map(
    Object.entries(lock.skills).map(([name, entry]) => [name, entry.source ?? entry.sourceUrl]),
  );
});

/** The text a provider lists for each skill the model may invoke, every turn. */
export function skillListingText(driver: string, skill: ServerProviderSkill): string {
  const description = skill.description ?? skill.shortDescription ?? "";
  return driver === "codex"
    ? `- ${skill.name}: ${description} (file: ${skill.path})\n`
    : `- ${skill.name}: ${description}\n`;
}

/** Claude never lists a disable-model-invocation skill; a shadowed copy never loads at all. */
const isListed = (driver: string, candidate: SkillCandidate) =>
  candidate.skill.enabled &&
  !candidate.shadowed &&
  !(driver === "claudeAgent" && candidate.skill.userInvocationOnly === true);

/**
 * Where each skill comes from, what its listing costs, and which other sources offer the same
 * skill. Duplicates match on the name without a plugin prefix, so `tdd` and `plugin:tdd` pair.
 */
export const describeSkills = Effect.fn("SkillProvenance.describeSkills")(function* (
  candidates: ReadonlyArray<SkillCandidate>,
  locations: SkillLocations,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* readSkillLock(locations.home);
  const within = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const npxRoot = path.join(locations.home, ".agents", "skills");
  const userRoot = path.join(locations.configDir, "skills");
  const codex = locations.driver === "codex";

  const originOf = (
    candidate: SkillCandidate,
    skillDir: string,
    realDir: string,
  ): AgentContextSkillOrigin => {
    if (candidate.plugin !== undefined)
      return {
        kind: "plugin",
        label: candidate.plugin.version
          ? `${candidate.plugin.name}@${candidate.plugin.version}`
          : candidate.plugin.name,
      };
    if (within(npxRoot, skillDir) || within(npxRoot, realDir)) {
      const source = lock.get(path.basename(realDir)) ?? lock.get(path.basename(skillDir));
      return { kind: "npx", label: "npx skills", ...(source ? { detail: source } : {}) };
    }
    if (within(path.join(userRoot, ".system"), skillDir))
      return { kind: "codex", label: "Codex system skills" };
    if (within(userRoot, skillDir))
      return codex
        ? { kind: "codex", label: "Codex skills" }
        : { kind: "user", label: "User skills" };
    if (locations.cwd !== null && within(locations.cwd, skillDir))
      return { kind: "project", label: "Project skills" };
    if (candidate.skill.scope === "admin" || candidate.skill.scope === "managed")
      return { kind: "managed", label: "Managed skills" };
    return { kind: "other", label: path.dirname(skillDir) };
  };

  // Codex reports a linked skill at its resolved path; name the link that exposes it instead.
  const exposedBy = new Map<string, string>();
  for (const root of [userRoot, npxRoot]) {
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries) {
      const dir = path.join(root, entry);
      const real = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
      if (real !== dir && !exposedBy.has(real)) exposedBy.set(real, dir);
    }
  }

  const rows = yield* Effect.forEach(candidates, (candidate) =>
    Effect.gen(function* () {
      const reportedDir = path.dirname(candidate.skill.path);
      const linkDir = exposedBy.get(reportedDir);
      const skillPath =
        linkDir === undefined
          ? candidate.skill.path
          : path.join(linkDir, path.basename(candidate.skill.path));
      const realPath = yield* fs.realPath(skillPath).pipe(Effect.orElseSucceed(() => skillPath));
      const skillDir = path.dirname(skillPath);
      const realDir = path.dirname(realPath);
      const linked =
        realPath !== skillPath ||
        (yield* fs.realPath(skillDir).pipe(Effect.orElseSucceed(() => skillDir))) !== skillDir;
      const bytes = yield* fs.stat(realPath).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0),
      );
      const listed = isListed(locations.driver, candidate);
      const listingBytes = listed
        ? Buffer.byteLength(skillListingText(locations.driver, candidate.skill), "utf8")
        : 0;
      const baseName = candidate.skill.name.slice(candidate.skill.name.lastIndexOf(":") + 1);
      return {
        name: candidate.skill.name,
        baseName,
        ...(candidate.skill.description ? { description: candidate.skill.description } : {}),
        path: skillPath,
        realPath,
        linked,
        bytes,
        origin: originOf(candidate, skillDir, realDir),
        listed,
        shadowed: candidate.shadowed,
        listingBytes,
        listingTokens: Math.ceil(listingBytes / 4),
        generated: [],
      };
    }),
  );
  const byBaseName = Map.groupBy(rows, (row) => row.baseName);
  return rows.map((row): SkillRow => ({
    ...row,
    duplicates: [
      ...new Set(
        (byBaseName.get(row.baseName) ?? [])
          .filter((other) => other !== row)
          .map((other) => other.origin.label),
      ),
    ],
  }));
});
