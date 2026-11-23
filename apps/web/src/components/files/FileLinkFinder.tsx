import {
  filterFileLinkCandidates,
  findFileLinkCandidates,
  type FileLinkCandidate,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useState, type KeyboardEvent } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, useProjects } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

// Rows render as plain DOM, so a parent folder's hundreds of matches arrive a page at a time.
const FINDER_PAGE_SIZE = 100;

type FinderState =
  | { readonly status: "idle" }
  | { readonly status: "searching" }
  | {
      readonly status: "done";
      readonly candidates: ReadonlyArray<FileLinkCandidate>;
      readonly complete: boolean;
    };

/**
 * Lists the files a missing chat link may have meant, across the thread's root, its environment's
 * projects and the folders the linking reply worked in. Nothing opens until the user picks one.
 */
export function FileLinkFinder(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  relativePath: string;
  searchFolders: ReadonlyArray<string>;
  revealLine: number | null;
  revealEndLine: number | null;
}) {
  const projects = useProjects();
  const searchEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
    refresh: true,
  });
  const browseFolder = useAtomQueryRunner(filesystemEnvironment.browse, {
    reportFailure: false,
    reportDefect: false,
  });
  const [state, setState] = useState<FinderState>({ status: "idle" });
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [rowLimit, setRowLimit] = useState(FINDER_PAGE_SIZE);
  const [active, setActive] = useState(0);
  const basename = fileBasename(props.relativePath);

  const find = async () => {
    setState({ status: "searching" });
    const threadProjectId = readThreadShell(props.threadRef)?.projectId;
    // A search of a parent such as ~/code does not reach into the repositories inside it.
    const listing = await browseFolder({
      environmentId: props.environmentId,
      input: { partialPath: /[\\/]$/.test(props.cwd) ? props.cwd : `${props.cwd}/` },
    });
    const childFolders =
      listing._tag === "Success"
        ? listing.value.entries
            .filter((entry) => !entry.name.startsWith("."))
            .map((entry) => entry.fullPath)
        : [];
    const roots = [
      props.cwd,
      ...childFolders,
      ...projects.flatMap((project) =>
        project.environmentId === props.environmentId && project.id !== threadProjectId
          ? [project.workspaceRoot]
          : [],
      ),
      ...props.searchFolders,
    ];
    const found = await findFileLinkCandidates({
      linkPath: props.relativePath,
      roots,
      search: async (root, query, limit) => {
        const result = await searchEntries({
          environmentId: props.environmentId,
          input: { cwd: root, query, limit, kind: "file" },
        });
        return result._tag === "Success" ? result.value : null;
      },
    });
    setState({ status: "done", ...found, complete: found.complete && listing._tag === "Success" });
  };

  const open = (path: string) =>
    useRightPanelStore
      .getState()
      .openFile(props.threadRef, workspaceRelativeFilePath(path, props.cwd) ?? path, {
        line: props.revealLine ?? undefined,
        endLine: props.revealEndLine ?? undefined,
      });

  if (state.status !== "done") {
    return (
      <Button
        variant="outline"
        size="sm"
        className="self-center"
        disabled={state.status === "searching"}
        onClick={() => void find()}
      >
        {state.status === "searching" ? `Finding ${basename}…` : `Find ${basename}`}
      </Button>
    );
  }

  const { listed, hiddenCount } = filterFileLinkCandidates(state.candidates, query, showHidden);
  const rows = listed.slice(0, rowLimit);
  const activeIndex = Math.min(active, rows.length - 1);
  const listId = `file-link-finder-${props.threadRef.threadId}`;
  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.max(0, Math.min(rows.length - 1, activeIndex + step)));
    } else if (event.key === "Enter" && rows[activeIndex]) {
      event.preventDefault();
      open(rows[activeIndex].path);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-left">
      <p className="text-muted-foreground">
        {state.candidates.length === 0
          ? `No file named ${basename} was found.`
          : `${state.candidates.length} files named ${basename}. Pick the one the link meant.`}
        {state.complete
          ? null
          : " Some searches were cut off or failed, so this list may be incomplete."}
      </p>
      {state.candidates.length > 0 ? (
        <>
          <Input
            type="search"
            size="sm"
            font="mono"
            role="combobox"
            aria-label={`Filter files named ${basename}`}
            aria-controls={listId}
            aria-expanded
            aria-activedescendant={rows[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            placeholder="Filter by path"
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setActive(0);
            }}
            onKeyDown={onFilterKeyDown}
          />
          {hiddenCount > 0 ? (
            <p className="text-muted-foreground">
              {showHidden
                ? `Showing ${hiddenCount} matches in dependency, build, hidden or ignored folders. `
                : `Hiding ${hiddenCount} matches in dependency, build, hidden or ignored folders. `}
              <Button variant="link" size="xs" onClick={() => setShowHidden(!showHidden)}>
                {showHidden ? "Hide them" : "Show all"}
              </Button>
            </p>
          ) : null}
          <ul
            id={listId}
            role="listbox"
            aria-label={`Files named ${basename}`}
            className="flex flex-col gap-1"
          >
            {rows.map((candidate, index) => (
              <li
                key={candidate.path}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                ref={
                  index === activeIndex
                    ? (element) => element?.scrollIntoView({ block: "nearest" })
                    : undefined
                }
                className="w-full cursor-pointer rounded-md px-2 py-1 font-mono break-all text-foreground hover:bg-accent aria-selected:bg-accent"
                onClick={() => open(candidate.path)}
                onPointerMove={() => setActive(index)}
              >
                {candidate.path}
              </li>
            ))}
          </ul>
          {listed.length === 0 ? (
            <p className="text-muted-foreground">No listed path contains that text.</p>
          ) : null}
          {listed.length > rows.length ? (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              onClick={() => setRowLimit(rowLimit + FINDER_PAGE_SIZE)}
            >
              Show more ({listed.length - rows.length} more)
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
