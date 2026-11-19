import { ensureBrowseDirectoryPath, getBrowseDirectoryPath } from "./state/projects.ts";
import { scoreQueryMatch } from "@t3tools/shared/searchRanking";

interface PickerProject {
  readonly key: string;
  readonly environmentId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly pathLabel?: string;
  readonly pinned: boolean;
  readonly activity: number;
}

export function isProjectPickerPath(query: string): boolean {
  return /^(?:[~/.]|[a-z]:|\\\\)/i.test(query.trim());
}

export function projectPickerPathLabel(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const windows = /^[a-z]:|^\\\\/i.test(path);
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const root = normalize(home);
  const normalizedPath = normalize(path);
  return normalizedPath === root || normalizedPath.startsWith(`${root}/`)
    ? `~${path.slice(home.replace(/[\\/]+$/, "").length)}`
    : path;
}

export function rankPickerProjects<T extends PickerProject>(
  projects: ReadonlyArray<T>,
  environmentId: string | null,
  query: string,
): T[] {
  const search = query.trim().normalize("NFC").toLowerCase().replaceAll("\\", "/");
  const candidates = projects.filter(
    (project) => environmentId === null || project.environmentId === environmentId,
  );
  const score = (value: string) =>
    scoreQueryMatch({
      value: value.normalize("NFC").toLowerCase().replaceAll("\\", "/"),
      query: search,
      exactBase: 0,
      prefixBase: 1000,
      boundaryBase: 2000,
      includesBase: 3000,
      fuzzyBase: 4000,
      boundaryMarkers: ["/", " ", "-", "_", "."],
    });
  return candidates
    .map((project) => ({
      project,
      score: search
        ? Math.min(
            ...[project.title, project.workspaceRoot, project.pathLabel ?? ""].map(
              (value) => score(value) ?? Infinity,
            ),
          )
        : 0,
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort(
      (a, b) =>
        a.score - b.score ||
        b.project.activity - a.project.activity ||
        a.project.key.localeCompare(b.project.key),
    )
    .map(({ project }) => project);
}

export function completePickerFolder(query: string, folderName: string | null): string {
  return folderName === null
    ? query
    : ensureBrowseDirectoryPath(`${getBrowseDirectoryPath(query.trim())}${folderName}`);
}

/**
 * The picker's list before anything is typed: places with past work, pinned first, then by
 * recency. A project with no threads stays out, even when pinned or current, so it is found by
 * typing. `environmentId` null lists every machine.
 */
export function pickerRecentProjects<T extends PickerProject>(
  projects: ReadonlyArray<T>,
  environmentId: string | null,
): T[] {
  const worked = rankPickerProjects(projects, environmentId, "").filter(
    (project) => project.activity > 0,
  );
  return [...worked.filter((project) => project.pinned), ...worked.filter((p) => !p.pinned)];
}
