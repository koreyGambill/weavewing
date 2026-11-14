import type { SavedTileLayout } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import type { useSavedTileLayouts } from "./useSavedTileLayouts";

const NONE = "none";
const INHERIT = "inherit";
export const MAX_TILE_LAYOUTS = 32;

export const TILE_LAYOUTS_SETTINGS_TARGET = {
  to: "/settings/threads",
  hash: "tile-layouts",
} as const;

function Radio(props: { value: string; children: ReactNode }) {
  return (
    <MenuRadioItem value={props.value}>
      <span className="flex items-center justify-between gap-4">
        <span className="max-w-64 truncate">{props.children}</span>
        <MenuRadioItemIndicator />
      </span>
    </MenuRadioItem>
  );
}

function LayoutRadios(props: { layouts: readonly SavedTileLayout[] }) {
  return props.layouts.map((layout) => (
    <Radio key={layout.id} value={layout.id}>
      {layout.name}
    </Radio>
  ));
}

export function TileLayoutsSubmenu(props: {
  api: ReturnType<typeof useSavedTileLayouts>;
  hasProject: boolean;
  onSaveAs: () => void;
  onApply: (layout: SavedTileLayout) => void;
}) {
  const navigate = useNavigate();
  const { api } = props;
  const globalName = api.layouts.find((layout) => layout.id === api.globalDefaultId)?.name;
  return (
    <MenuSub>
      <MenuSubTrigger>Layouts</MenuSubTrigger>
      <MenuSubPopup>
        <MenuItem onClick={props.onSaveAs}>Save layout as…</MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={!api.layouts.length}>Apply layout</MenuSubTrigger>
          <MenuSubPopup>
            {api.layouts.map((layout) => (
              <MenuItem key={layout.id} onClick={() => props.onApply(layout)}>
                <span className="block max-w-64 truncate">{layout.name}</span>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        {props.hasProject && (
          <MenuSub>
            <MenuSubTrigger>Default for this project</MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                value={
                  api.projectDefaultId === undefined ? INHERIT : (api.projectDefaultId ?? NONE)
                }
                onValueChange={(value: string) =>
                  api.setProjectDefault(
                    value === INHERIT ? undefined : value === NONE ? null : value,
                  )
                }
              >
                <Radio value={INHERIT}>Use global default ({globalName ?? "None"})</Radio>
                <Radio value={NONE}>None</Radio>
                <LayoutRadios layouts={api.layouts} />
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        )}
        <MenuSub>
          <MenuSubTrigger>Default for all projects</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={
                api.layouts.some((layout) => layout.id === api.globalDefaultId)
                  ? api.globalDefaultId!
                  : NONE
              }
              onValueChange={(value: string) => api.setGlobalDefault(value === NONE ? null : value)}
            >
              <Radio value={NONE}>None</Radio>
              <LayoutRadios layouts={api.layouts} />
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate(TILE_LAYOUTS_SETTINGS_TARGET)}>
          Manage layouts…
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}

export function SaveTileLayoutDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layouts: readonly SavedTileLayout[];
  dropped: boolean;
  onSave: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const replaces = props.layouts.some((layout) => layout.name === trimmed);
  const full = !replaces && props.layouts.length >= MAX_TILE_LAYOUTS;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmed || full) return;
            props.onSave(trimmed);
            props.onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Save layout</DialogTitle>
            <DialogDescription>
              Saves tiles, areas and split sizes. New threads open fresh terminals and pages.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={64}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
              {props.dropped && (
                <p className="text-xs text-muted-foreground">
                  Floating tiles and pull request, file, device and side chat tabs are not saved.
                </p>
              )}
              {replaces && (
                <p className="text-xs text-muted-foreground">
                  A layout with this name exists and will be replaced.
                </p>
              )}
              {full && (
                <p className="text-xs text-destructive-foreground">
                  You have {MAX_TILE_LAYOUTS} layouts. Delete one in Settings to save another.
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmed || full}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
