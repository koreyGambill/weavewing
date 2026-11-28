import { MAX_SAVED_TILE_GROUPS, type SavedTileLayout } from "@t3tools/contracts";
import { useId, useState } from "react";

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

const MAX_TILE_LAYOUTS = 32;

export const TILE_LAYOUTS_SETTINGS_TARGET = {
  to: "/settings/threads",
  hash: "tile-layouts",
} as const;

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
