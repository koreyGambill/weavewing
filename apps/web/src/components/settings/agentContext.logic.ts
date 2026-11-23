import {
  findProjectByPath,
  normalizeProjectPathForComparison,
} from "@t3tools/client-runtime/state/projects";
import {
  type AgentContextGeneratedRange,
  type AgentContextOverview,
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

/** Repositories with uncommitted changes. */
export const pendingCommits = (overview: AgentContextOverview) =>
  overview.repos.filter((repo) => repo.dirtyCount > 0);

/**
 * Where a commit thread for `root` runs: the page's checkout when it is that repository, else
 * the project rooted there. Null means no project holds it yet.
 */
export function commitThreadTarget(
  root: string,
  projects: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>,
  checkout: { readonly projectId: string; readonly worktreePath: string } | undefined,
): { readonly projectId: string; readonly worktreePath: string | null } | null {
  if (
    checkout !== undefined &&
    normalizeProjectPathForComparison(checkout.worktreePath) ===
      normalizeProjectPathForComparison(root)
  )
    return { projectId: checkout.projectId, worktreePath: checkout.worktreePath };
  const project = findProjectByPath(projects, root);
  return project === undefined ? null : { projectId: project.id, worktreePath: null };
}

export const commitPrompt = (root: string) =>
  `Commit every change in ${root}. If a file should not be committed (for example it looks like a secret, a build artifact or scratch), move it, delete it or add it to .gitignore instead, and tell me which files and why. Do not push.`;

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
