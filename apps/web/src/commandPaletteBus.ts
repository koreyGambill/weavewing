import type {
  EnvironmentId,
  PullRequestLinkedThreadsResult,
  ScopedProjectRef,
} from "@t3tools/contracts";

import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /** Add project hands the chosen folder's project here instead of opening a new thread in it. */
  readonly onProjectReady?: (projectRef: ScopedProjectRef) => Promise<unknown>;
  /** Skips Add project's source list: browse for a folder, or pick where to clone from. */
  readonly addProjectStart?: AddProjectStart;
}

export type AddProjectStart =
  | { readonly step: "folder"; readonly environmentId: EnvironmentId; readonly query: string }
  | { readonly step: "clone"; readonly environmentId: EnvironmentId };

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  if (detail.open === "new-thread-in") {
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({
      _tag: "OpenAddProject",
      ...(detail.onProjectReady ? { onProjectReady: detail.onProjectReady } : {}),
      ...(detail.addProjectStart ? { start: detail.addProjectStart } : {}),
    });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
