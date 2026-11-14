import type { EnvironmentId, ProjectId, SavedTileLayout, SavedTileNode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import {
  getClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { resolveDefaultTileLayout } from "../../savedTileLayouts";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { readProjects } from "../../state/entities";
import { readEnvironments, readPrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { planScopedSettingsClear, planScopedSettingsPatch } from "../settings/scopedSettings";
import { resolveSettingsScope } from "../settings/settingsScope";
import { useRunScopedPlan } from "../settings/useScopedSettings";

/** The project group the Settings project scope edits, built only when the menu writes. */
function readProjectGroupScope(environmentId: EnvironmentId, projectId: ProjectId) {
  const environments = readEnvironments();
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  const { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides } = getClientSettings();
  const groups = buildSidebarProjectSnapshots({
    projects: readProjects(),
    settings: { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides },
    primaryEnvironmentId: readPrimaryEnvironmentId(),
    resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
  });
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    ),
  );
  return {
    environments,
    scope: resolveSettingsScope({ project: group?.projectKey ?? "" }, groups, environments),
  };
}

/** Saved tile layouts live in server settings, so they follow the user across clients. */
export function useSavedTileLayouts(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const projectOverridesSupported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.projectSettingsOverrides === true,
  );
  const runPlan = useRunScopedPlan();
  const layouts = settings.tileLayouts;
  const override = projectId ? settings.projectSettingsOverrides[projectId] : undefined;
  return {
    layouts,
    globalDefaultId: settings.defaultTileLayoutId,
    /** Null when this environment's server cannot store project overrides. */
    projectId: projectOverridesSupported ? projectId : null,
    /** undefined follows the global default; null opens new threads without a layout. */
    projectDefaultId:
      override && Object.hasOwn(override, "defaultTileLayoutId")
        ? override.defaultTileLayoutId
        : undefined,
    effectiveDefault: resolveDefaultTileLayout(settings, projectId),
    /** A layout with the same name is replaced in place. */
    save: (name: string, root: SavedTileNode) => {
      const existing = layouts.find((layout) => layout.name === name);
      const layout: SavedTileLayout = { id: existing?.id ?? randomUUID(), name, root };
      updateSettings({
        tileLayouts: existing
          ? layouts.map((entry) => (entry.id === existing.id ? layout : entry))
          : [...layouts, layout],
      });
      return layout;
    },
    setGlobalDefault: (id: string | null) => updateSettings({ defaultTileLayoutId: id }),
    /** Writes every checkout in the project group, as the Settings project scope does. */
    setProjectDefault: (id: string | null | undefined) => {
      if (!projectId || !projectOverridesSupported) return;
      const { scope, environments } = readProjectGroupScope(environmentId, projectId);
      runPlan(
        id === undefined
          ? planScopedSettingsClear(scope, environments, ["defaultTileLayoutId"])
          : planScopedSettingsPatch(scope, environments, { defaultTileLayoutId: id }),
      );
    },
  };
}
