import { type SavedTileLayout } from "@t3tools/contracts";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";

import { savedTileGroupCount, TILE_LAYOUT_AREA_LABELS } from "../../savedTileLayouts";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NONE = "none";

function areaSummary(layout: SavedTileLayout) {
  const areas: string[] = [];
  const walk = (node: SavedTileLayout["root"]) => {
    if (node.kind === "group") {
      areas.push(...node.areas.map((area) => TILE_LAYOUT_AREA_LABELS[area]));
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  walk(layout.root);
  const tiles = savedTileGroupCount(layout.root);
  return `${tiles} ${tiles === 1 ? "tile" : "tiles"} · ${areas.join(", ")}`;
}

/** Scoped like the other new-thread defaults: global here, an override on a project's page. */
export function TileLayoutDefaultRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["defaultTileLayoutId"]);
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const current = settings.tileLayouts.find((layout) => layout.id === settings.defaultTileLayoutId);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultTileLayoutId"]}
      mixed={mixed}
      {...searchableSetting("default-tile-layout")}
      description={
        isProjectScope
          ? "Tile layout for new threads in this project. Existing threads keep theirs."
          : "Tile layout for new threads. Projects can override it. Existing threads keep theirs."
      }
      resetAction={
        settings.defaultTileLayoutId !== null ? (
          <SettingResetButton
            label="default layout"
            onClick={() => updateSettings({ defaultTileLayoutId: null })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : (current?.id ?? NONE)}
          onValueChange={(value) => {
            if (value) updateSettings({ defaultTileLayoutId: value === NONE ? null : value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Default tile layout">
            <SelectValue>
              <span className="block max-w-48 truncate">
                {mixed ? "Mixed" : (current?.name ?? "None")}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={NONE}>None</SelectItem>
            {settings.tileLayouts.map((layout) => (
              <SelectItem key={layout.id} value={layout.id}>
                <span className="block max-w-64 truncate">{layout.name}</span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function TileLayoutsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const layouts = settings.tileLayouts;
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<SavedTileLayout | null>(null);
  const renameButtons = useRef(new Map<string, HTMLButtonElement>());
  const cancelRename = useRef(false);
  const finishRename = (save: boolean) => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (save && name)
      updateSettings({
        tileLayouts: layouts.map((layout) =>
          layout.id === renaming.id ? { ...layout, name } : layout,
        ),
      });
    const id = renaming.id;
    setRenaming(null);
    requestAnimationFrame(() => renameButtons.current.get(id)?.focus());
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["tileLayouts"]}
      {...searchableSetting("tile-layouts")}
      description="Save a layout from a tile's … menu. Layouts keep tiles, areas and split sizes; new threads open fresh terminals and pages."
    >
      <div className="flex flex-col gap-2 pt-3 pb-2">
        {layouts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No saved layouts.</p>
        ) : (
          layouts.map((layout) => (
            <div
              key={layout.id}
              role="group"
              aria-label={layout.name}
              className="flex min-h-9 items-center gap-2"
            >
              {renaming?.id === layout.id ? (
                <Input
                  aria-label={`Rename ${layout.name}`}
                  value={renaming.name}
                  maxLength={64}
                  autoFocus
                  className="min-w-0 flex-1"
                  onChange={(event) => setRenaming({ id: layout.id, name: event.target.value })}
                  onBlur={() => finishRename(!cancelRename.current)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== "Escape") return;
                    event.preventDefault();
                    // Escape would otherwise also close the settings overlay.
                    event.stopPropagation();
                    cancelRename.current = event.key === "Escape";
                    event.currentTarget.blur();
                  }}
                />
              ) : (
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words">
                    {layout.name}
                    {layout.id === settings.defaultTileLayoutId && (
                      <span className="ps-2 text-xs text-muted-foreground">Default</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{areaSummary(layout)}</p>
                </div>
              )}
              <Button
                ref={(element) => {
                  if (element) renameButtons.current.set(layout.id, element);
                  else renameButtons.current.delete(layout.id);
                }}
                variant="ghost-muted"
                size="icon-sm"
                aria-label={`Rename ${layout.name}`}
                onClick={() => {
                  cancelRename.current = false;
                  setRenaming({ id: layout.id, name: layout.name });
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost-destructive"
                size="icon-sm"
                aria-label={`Delete ${layout.name}`}
                onClick={() => setDeleting(layout)}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))
        )}
      </div>
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Open threads keep their tiles. New threads stop using it as a default.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting)
                  updateSettings({
                    tileLayouts: layouts.filter((layout) => layout.id !== deleting.id),
                    ...(settings.defaultTileLayoutId === deleting.id
                      ? { defaultTileLayoutId: null }
                      : {}),
                  });
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}
