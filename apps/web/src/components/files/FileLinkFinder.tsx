import {
  findFileLinkCandidates,
  type FileLinkCandidate,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { readThreadShell, useProjects } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { projectEnvironment } from "../../state/projects";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { Button } from "../ui/button";

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

  return (
    <div className="flex flex-col gap-2 text-left">
      <p className="text-muted-foreground">
        {state.candidates.length === 0
          ? `No file named ${basename} was found.`
          : `Files named ${basename}. Pick the one the link meant.`}
        {state.complete
          ? null
          : " Some searches were cut off or failed, so this list may be incomplete."}
      </p>
      {state.candidates.length > 0 ? (
        <ul aria-label={`Files named ${basename}`} className="flex flex-col gap-1">
          {state.candidates.map((candidate) => (
            <li key={candidate.path}>
              <button
                type="button"
                className="w-full rounded-md px-2 py-1 text-left font-mono break-all text-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => open(candidate.path)}
              >
                {candidate.path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
