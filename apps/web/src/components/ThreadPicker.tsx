import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";
import { useProjects, useVisibleThreadShells } from "~/state/entities";
import { useThreadSearch } from "~/state/queries";
import { Command, CommandInput, CommandItem, CommandList } from "./ui/command";

export function ThreadPicker({
  environmentId,
  excludeThreadId,
  unavailableReason,
  pending = false,
  onSelect,
}: {
  environmentId: EnvironmentId;
  excludeThreadId?: ThreadId;
  unavailableReason?: (thread: EnvironmentThreadShell) => string | undefined;
  pending?: boolean;
  onSelect: (threadId: ThreadId) => void;
}) {
  const threads = useVisibleThreadShells();
  const projects = useProjects();
  const [query, setQuery] = useState("");
  // Mounts older settled threads matching the query, which shells may leave out.
  useThreadSearch([environmentId], query, { titlesOnly: true });
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const search = query.trim().toLocaleLowerCase();
  const candidates = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.archivedAt === null &&
        thread.id !== excludeThreadId &&
        `${thread.title} ${projectNames.get(thread.projectId) ?? ""}`
          .toLocaleLowerCase()
          .includes(search),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <Command mode="none" value={query} onValueChange={setQuery} aria-label="Choose a thread">
      <CommandInput placeholder="Search threads or projects..." disabled={pending} />
      <CommandList className="max-h-80 overflow-y-auto">
        {candidates.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No active threads found.
          </div>
        ) : (
          candidates.map((thread) => {
            const reason = unavailableReason?.(thread);
            return (
              <CommandItem
                key={thread.id}
                value={thread.id}
                disabled={pending || reason !== undefined}
                onClick={() => onSelect(thread.id)}
              >
                <MessageSquareIcon aria-hidden className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{thread.title || "Untitled thread"}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {projectNames.get(thread.projectId)}
                  </span>
                </span>
                {reason ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    {reason}
                  </span>
                ) : null}
              </CommandItem>
            );
          })
        )}
      </CommandList>
    </Command>
  );
}
