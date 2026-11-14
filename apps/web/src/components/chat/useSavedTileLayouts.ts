import type {
  EnvironmentId,
  ProjectId,
  ProjectSettingsOverrides,
  SavedTileLayout,
  SavedTileNode,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { resolveDefaultTileLayout } from "../../savedTileLayouts";

/** Saved tile layouts live in server settings, so they follow the user across clients. */
export function useSavedTileLayouts(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const layouts = settings.tileLayouts;
  const override = projectId ? settings.projectSettingsOverrides[projectId] : undefined;
  const writeProjectDefault = (id: string | null | undefined) => {
    if (!projectId) return;
    const { defaultTileLayoutId: _previous, ...rest }: ProjectSettingsOverrides = override ?? {};
    updateSettings({
      projectSettingsOverrides: {
        [projectId]: id === undefined ? rest : { ...rest, defaultTileLayoutId: id },
      },
    });
  };
  return {
    layouts,
    globalDefaultId: settings.defaultTileLayoutId,
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
    setProjectDefault: writeProjectDefault,
  };
}
