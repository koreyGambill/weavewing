import {
  type AgentContextGeneratedRange,
  type AgentContextOverview,
  type AgentContextRepo,
  type AgentContextSkill,
  type LoadWatcher,
  loadWatcherError,
} from "@t3tools/contracts";

const ORIGIN_ORDER: ReadonlyArray<AgentContextSkill["origin"]["kind"]> = [
  "managed",
  "user",
  "codex",
  "npx",
  "plugin",
  "project",
  "other",
];

/** Skills grouped by where they come from, the user's own sources first. */
export function groupSkills(skills: ReadonlyArray<AgentContextSkill>) {
  const groups = new Map<string, { label: string; kind: string; skills: AgentContextSkill[] }>();
  for (const skill of skills) {
    const group = groups.get(skill.origin.label) ?? {
      label: skill.origin.label,
      kind: skill.origin.kind,
      skills: [],
    };
    group.skills.push(skill);
    groups.set(skill.origin.label, group);
  }
  return [...groups.values()].toSorted(
    (a, b) =>
      ORIGIN_ORDER.indexOf(a.kind as AgentContextSkill["origin"]["kind"]) -
        ORIGIN_ORDER.indexOf(b.kind as AgentContextSkill["origin"]["kind"]) ||
      a.label.localeCompare(b.label),
  );
}

/** What a new session pays for instructions, and each turn for the skill listing. */
export function agentContextTotals(overview: AgentContextOverview) {
  const sessionTokens = overview.instructions
    .filter((file) => file.status === "expected" && file.scope !== "link")
    .reduce((sum, file) => sum + file.estimatedTokens, 0);
  const listingTokens = overview.skills.reduce((sum, skill) => sum + skill.listingTokens, 0);
  const duplicateNames = new Set(
    overview.skills.filter((skill) => skill.duplicates.length > 0).map((skill) => skill.baseName),
  );
  return { sessionTokens, listingTokens, duplicates: duplicateNames.size };
}

/** Repositories with anything to commit; their Commit action offers every changed file. */
export const pendingCommits = (overview: AgentContextOverview) =>
  overview.repos.filter((repo) => repo.dirty.length > 0);

type DirtyFile = AgentContextRepo["dirty"][number];

/** A rename shows where it came from. */
export const dirtyLabel = (file: DirtyFile) =>
  file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`;

/**
 * Files a commit leaves out: those a person unchecked, and secret-looking untracked files they
 * have not checked, including ones that appear when the list refreshes.
 */
export const excludedPaths = (
  files: ReadonlyArray<DirtyFile>,
  choices: ReadonlyMap<string, boolean>,
) =>
  new Set(
    files.filter((file) => !(choices.get(file.path) ?? !file.secret)).map((file) => file.path),
  );

/** The paths a commit names: a rename takes its earlier path too, or the deletion stays behind. */
export const commitPaths = (root: string, files: ReadonlyArray<DirtyFile>) =>
  files.flatMap((file) =>
    [file.path, ...(file.origPath === undefined ? [] : [file.origPath])].map(
      (entry) => `${root}/${entry}`,
    ),
  );

/** What a commit leaves behind: the rows left unchecked, and any the listing could not show. */
export function leftUncommitted(repo: AgentContextRepo, excluded: ReadonlySet<string>) {
  const unlisted = repo.dirtyCount - repo.dirty.length;
  return [
    ...repo.dirty.filter((file) => excluded.has(file.path)).map(dirtyLabel),
    ...(unlisted > 0 ? [`${unlisted} more not listed`] : []),
  ];
}

export interface TextSegment {
  /** The segment's first line in the loaded file, which keys it while its text changes. */
  readonly start: number;
  readonly generated: boolean;
  readonly text: string;
}

/** Splits a file into editable text and generated blocks; joining the segments restores it. */
export function splitGenerated(
  text: string,
  ranges: ReadonlyArray<AgentContextGeneratedRange>,
): ReadonlyArray<TextSegment> {
  const lines = text.split("\n");
  const segments: TextSegment[] = [];
  // A segment holds whole lines, so the join's newlines are exactly the ones between segments.
  const pushLines = (generated: boolean, from: number, to: number) => {
    if (to > from)
      segments.push({ start: from, generated, text: lines.slice(from, to).join("\n") });
  };
  let next = 0;
  for (const range of ranges) {
    pushLines(false, next, range.startLine - 1);
    pushLines(true, range.startLine - 1, range.endLine);
    next = range.endLine;
  }
  pushLines(false, next, lines.length);
  return segments;
}

export const joinSegments = (segments: ReadonlyArray<TextSegment>) =>
  segments.map((segment) => segment.text).join("\n");

/** One message per watcher, null where the watcher is valid. */
export function watcherErrors(watchers: ReadonlyArray<LoadWatcher>) {
  return watchers.map((watcher) =>
    watcher.label.trim() === "" ? "Add a label." : loadWatcherError(watcher),
  );
}
