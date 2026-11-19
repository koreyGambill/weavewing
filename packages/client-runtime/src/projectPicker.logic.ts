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

interface PickerAddMachine<Id extends string> {
  readonly environmentId: Id;
  readonly canAddProject: boolean;
  readonly canWriteSourceControl: boolean;
}

export type PickerAddTarget<Id extends string> =
  | { readonly kind: "machine"; readonly environmentId: Id }
  | { readonly kind: "choose"; readonly environmentIds: ReadonlyArray<Id> }
  | { readonly kind: "none"; readonly reason: string };

/**
 * Where Open folder or Clone repo adds a project. Opening a folder needs add-project permission;
 * cloning also needs source-control write. Only the selected machine counts unless `allMachines`
 * is on. `machines` are the connected ones; ids in `first` lead a choice, in that order.
 */
export function pickerAddProjectTarget<Id extends string>(input: {
  readonly step: "folder" | "clone";
  readonly allMachines: boolean;
  readonly selectedEnvironmentId: Id | null;
  readonly machines: ReadonlyArray<PickerAddMachine<Id>>;
  readonly first: ReadonlyArray<Id | null>;
}): PickerAddTarget<Id> {
  const eligible = input.machines.filter(
    (machine) =>
      (input.allMachines || machine.environmentId === input.selectedEnvironmentId) &&
      machine.canAddProject &&
      (input.step === "folder" || machine.canWriteSourceControl),
  );
  const [only] = eligible;
  if (!only) {
    const where = input.allMachines ? "any connected machine" : "this machine";
    return {
      kind: "none",
      reason:
        input.step === "folder"
          ? `You can't add projects on ${where}.`
          : `You can't clone repositories on ${where}.`,
    };
  }
  if (eligible.length === 1) return { kind: "machine", environmentId: only.environmentId };
  const rank = (id: Id) => {
    const index = input.first.indexOf(id);
    return index === -1 ? input.first.length : index;
  };
  return {
    kind: "choose",
    environmentIds: eligible
      .map((machine) => machine.environmentId)
      .sort((a, b) => rank(a) - rank(b)),
  };
}
