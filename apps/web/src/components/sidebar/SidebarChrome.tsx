import { WorkspaceHistoryButton } from "../reviews/WorkspaceHistoryButton";
import { ArrowLeftIcon, ArrowRightIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../../navigationHistory";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { WeavewingMark } from "../WeavewingMark";
import { openCommandPalette } from "../../commandPaletteBus";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { ShortcutReferenceDialog } from "./ShortcutReferenceDialog";
import { SidebarUsageLimits } from "./SidebarUsageLimits";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

function useSidebarChromeStage() {
  const { isMobile } = useSidebar();
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  return { isMobile, backdropVariant, pillLabel };
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const { backdropVariant, pillLabel } = useSidebarChromeStage();

  return (
    <div
      data-sidebar-titlebar
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      {/* Wide layouts draw the cluster fixed in the window; the mobile sheet covers it. */}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <TitlebarControls
          expanded
          onBackdrop={backdropVariant !== null}
          collapser={
            <SidebarTrigger
              variant={backdropVariant ? "media-navigation" : "ghost"}
              className="relative top-auto translate-y-0"
              aria-label="Toggle main sidebar"
            />
          }
        />
      </div>
      {pillLabel ? (
        <div className="relative z-10 flex h-7 items-center md:ml-[var(--workspace-titlebar-content-left)]">
          <Badge data-environment-identification="pill" size="sm" variant="secondary">
            {pillLabel}
          </Badge>
        </div>
      ) : null}
    </div>
  );
});

function TitlebarWordmark({ probe = false }: { probe?: boolean }) {
  return (
    <span
      data-titlebar-wordmark
      className={cn(
        "drag-region min-w-max shrink-0 px-1.5 text-base leading-7 font-medium tracking-tight",
        !probe && "max-[501px]:hidden",
      )}
    >
      <span className="text-sidebar-muted-foreground">weave</span>
      <span className="text-(--weavewing-yellow)">wing</span>
    </span>
  );
}

/** Reports the wordmark's rendered width so content headers can clear the fixed title-bar cluster. */
export function TitlebarWidthProbe({
  onWordmarkWidthChange,
}: {
  onWordmarkWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) =>
    observeResize(probe, ([entry]) => {
      if (entry) onWordmarkWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max"
      ref={observeWidth}
    >
      <TitlebarWordmark probe />
    </div>
  );
}

/**
 * The window controls keep their arrangement independently of the sidebar.
 */
export function TitlebarControls({
  collapser,
  onBackdrop,
  compact = false,
  expanded = false,
}: {
  collapser: ReactNode;
  onBackdrop: boolean;
  compact?: boolean;
  expanded?: boolean;
}) {
  return (
    <div className="pointer-events-none flex items-center">
      <div className="pointer-events-auto flex shrink-0 items-center [-webkit-app-region:no-drag]">
        <CommandPaletteMarkButton onBackdrop={onBackdrop} />
        <TitlebarWordmark />
        {collapser}
      </div>
      <div
        className={cn(
          "pointer-events-auto flex shrink-0 items-center [-webkit-app-region:no-drag] max-[981px]:hidden",
          compact && !expanded && "max-md:hidden",
        )}
      >
        <HistoryNavigationButton direction="back" onBackdrop={onBackdrop} />
        <HistoryNavigationButton direction="forward" onBackdrop={onBackdrop} />
        <WorkspaceHistoryButton />
      </div>
    </div>
  );
}

function CommandPaletteMarkButton({ onBackdrop }: { onBackdrop: boolean }) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Command palette"
            className={onBackdrop ? "relative top-auto translate-y-0" : undefined}
            onClick={() => openCommandPalette()}
            size="icon-sm"
            variant={onBackdrop ? "media-navigation" : "ghost"}
          />
        }
      >
        <WeavewingMark
          aria-hidden
          // The mark's thin green and yellow strokes vanish on the light backdrop without a tile.
          className={cn("size-5", onBackdrop && "rounded-md bg-background/85 p-0.5")}
        />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Command palette{shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function HistoryNavigationButton({
  direction,
  onBackdrop,
}: {
  direction: HistoryDirection;
  onBackdrop: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const enabled = useCanNavigateHistory(direction);
  const label = direction === "back" ? "Go back" : "Go forward";
  const shortcutLabel = shortcutLabelForCommand(
    keybindings,
    direction === "back" ? "navigation.back" : "navigation.forward",
  );
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={onBackdrop ? "relative top-auto translate-y-0" : undefined}
            disabled={!enabled}
            onClick={() => navigateHistory(direction)}
            size="icon-sm"
            variant={onBackdrop ? "media-navigation" : "ghost"}
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  children,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <SidebarMenuItem className={children ? "flex min-w-0 items-center gap-1" : "shrink-0"}>
      <div className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
                {icon}
              </SidebarMenuButton>
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
      </div>
      {children}
    </SidebarMenuItem>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <SidebarMenu className="flex-row flex-wrap items-center">
      <SidebarUtilityItem
        icon={<span>/</span>}
        label="Shortcut reference"
        onClick={() => setShortcutsOpen(true)}
      />
      <ShortcutReferenceDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          >
            <SidebarUsageLimits />
          </SidebarUtilityItem>
        </>
      )}
      <SidebarThreadUndoNotice />
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
