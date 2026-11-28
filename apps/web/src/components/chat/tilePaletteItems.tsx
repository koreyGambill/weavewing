import type { KeybindingCommand, SavedTileLayout } from "@t3tools/contracts";
import { LayoutDashboardIcon, MonitorIcon } from "lucide-react";
import { updateClientSettings } from "../../hooks/useSettings";
import { dispatchMenuAction } from "../../shortcuts/dispatcher";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";

const TILE_PALETTE_COMMANDS = [
  { command: "workspace.tile.maximize", title: "Maximize or Restore Tile" },
  { command: "workspace.tile.focusPair", title: "Maximize, Show Beside or Restore Tile" },
  { command: "workspace.tile.swap", title: "Swap Tiles" },
  { command: "workspace.tile.rotate", title: "Rotate Tiles" },
  { command: "workspace.tile.resize", title: "Resize Focused Tile" },
  { command: "workspace.tile.focusLeft", title: "Focus Tile Left" },
  { command: "workspace.tile.focusDown", title: "Focus Tile Down" },
  { command: "workspace.tile.focusUp", title: "Focus Tile Up" },
  { command: "workspace.tile.focusRight", title: "Focus Tile Right" },
  { command: "workspace.tile.splitRight", title: "New Tile Right" },
  { command: "workspace.tile.splitDown", title: "New Tile Below" },
  { command: "workspace.tile.previousTab", title: "Previous Tab in Tile" },
  { command: "workspace.tile.nextTab", title: "Next Tab in Tile" },
  { command: "workspace.tile.float", title: "Float or Dock Tile" },
  { command: "workspace.tile.newTab", title: "New Tab in Tile" },
  { command: "workspace.tile.closeTab", title: "Close Tab in Tile" },
  { command: "workspace.tile.closeAllTabs", title: "Close All Tabs in Tile" },
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
  hasProject: boolean,
): CommandPaletteActionItem[] {
  const row = (
    command: string,
    title: string,
    action?: () => Promise<void>,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value: `action:${command}`,
    title,
    searchTerms: [title, "tile", "layout", "workspace"],
    icon: <LayoutDashboardIcon className={iconClassName} />,
    run: action ?? (async () => void setTimeout(() => dispatchMenuAction(command), 0)),
  });
  return [
    row("workspace.tile.layout.save", "Save Tile Layout As…"),
    row("workspace.tile.layout.clearGlobal", "Clear Default Tile Layout for All Projects"),
    ...(hasProject
      ? [
          row("workspace.tile.layout.clearProject", "Clear Default Tile Layout for This Project"),
          row(
            "workspace.tile.layout.inheritProject",
            "Use Global Default Tile Layout for This Project",
          ),
        ]
      : []),
    ...(
      [
        ["focused", "Open Links and Previews in Focused Tile"],
        ["system", "Open Web Links in the System Browser"],
        ["tile-1", "Open Links and Previews in Tile 1"],
        ["tile-2", "Open Links and Previews in Tile 2"],
      ] as const
    ).map(([destination, title]) =>
      row(`workspace.tile.links:${destination}`, title, async () => {
        await updateClientSettings(
          destination === "system"
            ? { browserLinkTarget: "system" }
            : { browserLinkTarget: "app", linkTileDestination: destination },
        );
      }),
    ),
    ...layouts.flatMap((layout) => [
      row(`workspace.tile.layout.apply:${layout.id}`, `Apply Tile Layout: ${layout.name}`),
      row(`workspace.tile.layout.replace:${layout.id}`, `Replace Tile Layout: ${layout.name}`),
      ...(hasProject
        ? [
            row(
              `workspace.tile.layout.projectDefault:${layout.id}`,
              `Use Tile Layout for New Threads in This Project: ${layout.name}`,
            ),
          ]
        : []),
      row(
        `workspace.tile.layout.globalDefault:${layout.id}`,
        `Use Tile Layout for All New Threads: ${layout.name}`,
      ),
    ]),
  ];
}
