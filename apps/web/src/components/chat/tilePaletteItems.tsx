import type { KeybindingCommand, SavedTileLayout } from "@t3tools/contracts";
import { LayoutDashboardIcon, MonitorIcon } from "lucide-react";
import { dispatchMenuAction } from "../../shortcuts/dispatcher";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";

const TILE_PALETTE_COMMANDS = [
  { command: "workspace.tile.maximize", title: "Maximize or Restore Tile" },
  { command: "workspace.tile.focusPair", title: "Maximize, Show Beside or Restore Tile" },
  { command: "workspace.tile.swap", title: "Swap Side-by-Side Tiles" },
  { command: "workspace.tile.float", title: "Float or Dock Tile" },
  { command: "workspace.tile.newTab", title: "New Tab in Tile" },
  { command: "workspace.tile.closeTab", title: "Close Tab in Tile" },
  { command: "workspace.tile.actions", title: "Tile Actions" },
] as const satisfies ReadonlyArray<{ command: KeybindingCommand; title: string }>;

/** Palette rows for the tile commands; each runs through the mounted workspace's menu action. */
export function tilePaletteItems(iconClassName: string): CommandPaletteActionItem[] {
  return TILE_PALETTE_COMMANDS.map(({ command, title }) => ({
    kind: "action",
    value: `action:${command}`,
    title,
    searchTerms: [title, "tile", "workspace"],
    icon: <MonitorIcon className={iconClassName} />,
    shortcutCommand: command,
    // The palette's focus restoration would close a tile menu opened in the same frame.
    run: async () => void setTimeout(() => dispatchMenuAction(command), 0),
  }));
}

/** Saved-layout rows for the mounted workspace; each layout gets apply and default rows. */
export function tileLayoutPaletteItems(
  iconClassName: string,
  layouts: readonly SavedTileLayout[],
): CommandPaletteActionItem[] {
  const row = (command: string, title: string): CommandPaletteActionItem => ({
    kind: "action",
    value: `action:${command}`,
    title,
    searchTerms: [title, "tile", "layout", "workspace"],
    icon: <LayoutDashboardIcon className={iconClassName} />,
    run: async () => void setTimeout(() => dispatchMenuAction(command), 0),
  });
  return [
    row("workspace.tile.layout.save", "Save Tile Layout As…"),
    ...layouts.flatMap((layout) => [
      row(`workspace.tile.layout.apply:${layout.id}`, `Apply Tile Layout: ${layout.name}`),
      row(
        `workspace.tile.layout.projectDefault:${layout.id}`,
        `Use Tile Layout for New Threads in This Project: ${layout.name}`,
      ),
      row(
        `workspace.tile.layout.globalDefault:${layout.id}`,
        `Use Tile Layout for All New Threads: ${layout.name}`,
      ),
    ]),
  ];
}
