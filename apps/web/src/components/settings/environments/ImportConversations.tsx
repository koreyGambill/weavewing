import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useProjectImport } from "~/onboarding/useProjectImport";
import { useProjectScans } from "~/onboarding/useProjectScans";
import type { WelcomeImportSelection } from "~/onboarding/welcomeState";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { ImportCandidateList, IMPORT_SOURCES_LABEL } from "../../onboarding/ImportCandidateList";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { ScrollArea } from "../../ui/scroll-area";
import { toastManager } from "../../ui/toast";

/**
 * Brings a server's Claude Code, Codex and Pi history in as projects and threads. Scanning reads
 * that history from disk, so it runs only when asked; the one button stays put through
 * Scan, Scanning… and Import N.
 */
export function ImportConversations({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [scanRequested, setScanRequested] = useState(false);
  return scanRequested ? (
    <ImportScan environmentId={environmentId} />
  ) : (
    <ImportLine
      status="Import conversations"
      action={
        <Button size="xs" variant="outline" onClick={() => setScanRequested(true)}>
          Scan
        </Button>
      }
    />
  );
}

function ImportLine({
  status,
  action,
}: {
  readonly status: string;
  readonly action: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 text-muted-foreground">{status}</span>
      <span className="flex w-28 shrink-0 justify-end">{action}</span>
    </div>
  );
}

function ImportScan({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const nowMinute = useNowMinute();
  const scans = useProjectScans([environmentId]);
  const scan = scans[0]!;
  const [selection, setSelection] = useState<WelcomeImportSelection | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [open, setOpen] = useState(false);
  // Nothing here leaves the page mid-import, so nothing needs holding.
  const holdPageRef = useRef(false);
  const projectImport = useProjectImport({
    scans,
    importSelection: selection,
    onImportSelectionChange: setSelection,
    isImporting,
    setIsImporting,
    holdPageRef,
    onDone: async (_landing, warning, importedThreadCount = 0) => {
      setIsImporting(false);
      setOpen(false);
      toastManager.add(
        warning
          ? { type: "warning", title: "Some history was not imported", description: warning }
          : {
              type: "success",
              title: `Imported ${importedThreadCount} ${importedThreadCount === 1 ? "thread" : "threads"}`,
            },
      );
      scan.refresh();
      return true;
    },
  });
  const fresh = projectImport.candidates.filter(projectImport.isNew);
  const scanned = scan.data
    ? `scanned ${formatRelativeTimeLabel(scan.data.scannedAt, Date.parse(nowMinute))}`
    : null;

  const openImport = () => {
    projectImport.setSelectedKeys(new Set(fresh.map((candidate) => candidate.key)));
    setOpen(true);
  };

  const line = scan.isPending ? (
    <ImportLine
      status="Import conversations"
      action={
        <Button size="xs" variant="outline" disabled>
          Scanning…
        </Button>
      }
    />
  ) : scan.error !== null ? (
    <ImportLine
      status={`Could not scan. ${scan.error}`}
      action={
        <Button size="xs" variant="outline" onClick={scan.refresh}>
          Retry
        </Button>
      }
    />
  ) : fresh.length > 0 ? (
    <ImportLine
      status={`Import conversations · ${scanned}`}
      action={
        <Button size="xs" variant="default" disabled={!projectImport.canWrite} onClick={openImport}>
          Import {fresh.length}
        </Button>
      }
    />
  ) : (
    <ImportLine
      status={`Nothing new to import · ${scanned}`}
      action={
        <Button size="xs" variant="outline" onClick={scan.refresh}>
          Scan again
        </Button>
      }
    />
  );

  const selected = projectImport.selected;
  return (
    <>
      {line}
      {projectImport.visibleImportError ? (
        <p className="text-xs text-destructive">{projectImport.visibleImportError}</p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!isImporting) setOpen(next);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Import conversations</DialogTitle>
            <DialogDescription>From your {IMPORT_SOURCES_LABEL} history.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <fieldset disabled={isImporting}>
              <ScrollArea scrollFade className="h-auto max-h-96">
                <div className="space-y-0.5 pr-3">
                  <ImportCandidateList
                    candidates={projectImport.candidates}
                    selectedKeys={projectImport.selectedKeys}
                    onSelectionChange={projectImport.setSelectedKeys}
                  />
                </div>
              </ScrollArea>
            </fieldset>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" disabled={isImporting} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={isImporting || selected.length === 0}
              onClick={() => void projectImport.runImport(selected)}
            >
              {isImporting
                ? "Importing…"
                : `Import ${selected.length} ${selected.length === 1 ? "project" : "projects"}`}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
