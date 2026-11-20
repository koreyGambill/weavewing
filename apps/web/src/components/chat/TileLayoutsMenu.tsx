import { MAX_SAVED_TILE_GROUPS, type SavedTileLayout } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayoutTemplate } from "lucide-react";
import { useContext, useId, useState, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { BackgroundThreadContext } from "./backgroundThread";
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
  Menu,
  MenuPopup,
  MenuTrigger,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { useSavedTileLayouts } from "./useSavedTileLayouts";

const NONE = "none";
const INHERIT = "inherit";
const MAX_TILE_LAYOUTS = 32;

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

export function TileLayoutsMenu(props: {
  api: ReturnType<typeof useSavedTileLayouts>;
  hasProject: boolean;
  onSaveAs: () => void;
  onReplace: (id: string) => void;
  onApply: (layout: SavedTileLayout) => void;
}) {
  const navigate = useNavigate();
  const background = useContext(BackgroundThreadContext);
  const hasRoom = useMediaQuery("(min-width: 480px)");
  const { api } = props;
  const globalName = api.layouts.find((layout) => layout.id === api.globalDefaultId)?.name;
  if (background || !hasRoom) return null;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Layouts" />} />
          }
        >
          <LayoutTemplate className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Layouts</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <MenuItem onClick={props.onSaveAs}>Save layout as…</MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={!api.layouts.length}>Replace layout</MenuSubTrigger>
          <MenuSubPopup>
            {api.layouts.map((layout) => (
              <MenuItem key={layout.id} onClick={() => props.onReplace(layout.id)}>
                <span className="block max-w-64 truncate">{layout.name}</span>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
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
      </MenuPopup>
    </Menu>
  );
}

export function SaveTileLayoutDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  layouts: readonly SavedTileLayout[];
  replaceId: string | null;
  dropped: boolean;
  tiles: number;
  onSave: (name: string) => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const replacing = props.replaceId !== null;
  const target = props.layouts.find((layout) => layout.id === props.replaceId);
  const trimmed = replacing ? (target?.name ?? "") : name.trim();
  const replacesByName = !replacing && props.layouts.some((layout) => layout.name === trimmed);
  const full = !replacing && !replacesByName && props.layouts.length >= MAX_TILE_LAYOUTS;
  const tooManyTiles = props.tiles > MAX_SAVED_TILE_GROUPS;
  const blocked = !trimmed || full || tooManyTiles || props.tiles === 0;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked) return;
            props.onSave(trimmed);
            props.onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{replacing ? "Replace layout" : "Save layout"}</DialogTitle>
            <DialogDescription>
              {replacing
                ? target
                  ? `Replace “${target.name}” with the current tiles, areas and split sizes.`
                  : "This saved layout is no longer available."
                : "Saves tiles, areas and split sizes. New threads open fresh terminals and pages."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              {replacing ? null : (
                <>
                  <Label htmlFor={`${id}-name`}>Name</Label>
                  <Input
                    id={`${id}-name`}
                    value={name}
                    maxLength={64}
                    autoFocus
                    onChange={(event) => setName(event.target.value)}
                  />
                </>
              )}
              {props.dropped && (
                <p className="text-xs text-muted-foreground">
                  Floating tiles and pull request, file, device and side chat tabs are not saved.
                </p>
              )}
              {replacesByName && (
                <p className="text-xs text-muted-foreground">
                  A layout with this name exists and will be replaced.
                </p>
              )}
              {props.tiles === 0 && (
                <p className="text-xs text-destructive-foreground">
                  Keep at least one docked area to save this layout.
                </p>
              )}
              {tooManyTiles && (
                <p className="text-xs text-destructive-foreground">
                  Layouts keep up to {MAX_SAVED_TILE_GROUPS} tiles; this one has {props.tiles}.
                  Close or merge tiles to save it.
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
            <Button type="submit" disabled={blocked}>
              {replacing || replacesByName ? "Replace" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
