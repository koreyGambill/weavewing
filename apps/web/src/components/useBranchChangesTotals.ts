import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import {
  selectThreadBranchBaseRef,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "~/diffPanelStore";
import { useClientSettings } from "~/hooks/useSettings";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { gitDiffPreviewQuery } from "~/state/gitDiffPreviewQuery";
import { resolveChangesTotals } from "./GitActionsControl.logic";

export function useBranchChangesTotals({
  enabled,
  threadRef,
  cwd,
  workspaceMutationId,
  gitStatus,
}: {
  enabled: boolean;
  threadRef: ScopedThreadRef | null;
  cwd: string | null;
  workspaceMutationId: string | null;
  gitStatus: VcsStatusResult | null;
}) {
  const baseRef = useDiffPanelStore((state) => selectThreadBranchBaseRef(state, threadRef));
  const ignoreWhitespaceSetting = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const ignoreWhitespace =
    useDiffPanelSessionStore((state) => state.ignoreWhitespace) ?? ignoreWhitespaceSetting;
  const { canReadFiles } = useFilesystemReadAccess(threadRef?.environmentId ?? null);
  const previewEnabled = enabled && canReadFiles && gitStatus?.isRepo === true && threadRef && cwd;
  const preview = useEnvironmentQuery(
    previewEnabled
      ? gitDiffPreviewQuery(
          threadRef.environmentId,
          {
            cwd,
            ...(baseRef ? { baseRef } : {}),
            ignoreWhitespace,
            metadataOnly: true,
            sourceKind: "branch-range",
          },
          workspaceMutationId,
          gitStatus,
        )
      : null,
  );
  if (!enabled) return null;
  const branch = preview.data?.sources.find((source) => source.kind === "branch-range");
  // When Diff can run, raw status only matches its automatic base with whitespace included.
  return resolveChangesTotals(
    !previewEnabled || (!baseRef && !ignoreWhitespace) ? gitStatus : null,
    branch,
  );
}
