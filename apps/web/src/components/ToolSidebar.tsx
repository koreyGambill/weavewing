import { useAtomValue } from "@effect/atom-react";
import {
  ActivityIcon,
  CalendarIcon,
  Settings2Icon,
  Maximize2,
  Minimize2,
  PanelRight,
  X,
} from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { isElectron } from "../env";
import { useResizeDrag } from "../hooks/useResizeDrag";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { observeResize } from "../lib/observeResize";
import { resolveToolSidebarWidth, TOOL_SIDEBAR_RAIL_WIDTH } from "./ToolSidebar.logic";
import { WorkspaceTitlebarControlsHost, WorkspaceTitlebarHost } from "./WorkspaceTitlebar";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useToolSidebarStore } from "../toolSidebarStore";
import { CalendarTool } from "./CalendarTool";
import { DropdownTerminalButton } from "./DropdownTerminal";
import { StatusSourcesList, useStatusSignal } from "./statusSources/StatusSources";
import { StatusSourceDot } from "./statusSources/StatusSourceIcon";
import { Button } from "./ui/button";
import { useMobileSidebarSheetMounted } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ToolSidebarLayout({ children }: { children: ReactNode }) {
  const { visible, activeTool, width, maximized, dispatch } = useToolSidebarStore();
  const { state: statusState } = useStatusSignal();
  const statusAlert = statusState === "fail" || statusState === "warn" ? statusState : null;
  const [availableWidth, setAvailableWidth] = useState(1280);
  const pageWidth = resolveToolSidebarWidth(width, availableWidth);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  const isWide = useMediaQuery("(min-width: 981px)");
  const [titlebarHost, setTitlebarHost] = useState<HTMLElement | null>(null);
  const [titlebarControlsHost, setTitlebarControlsHost] = useState<HTMLElement | null>(null);
  const shortcut = shortcutLabelForCommand(keybindings, "toolSidebar.toggle");
  const toggle = () => {
    const state = useToolSidebarStore.getState();
    state.dispatch(
      !window.matchMedia("(min-width: 981px)").matches && !state.activeTool
        ? { type: "select", tool: "calendar" }
        : { type: "toggle" },
    );
  };
  const [commandsRef] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    const stopObserving = observeResize(node, () => setAvailableWidth(node.clientWidth));
    setAvailableWidth(node.clientWidth);
    const stopMenu = registerMenuAction("toolSidebar.toggle", () => {
      toggle();
    });
    const stopCommands = registerCommands(
      {
        "toolSidebar.toggle": (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggle();
        },
      },
      { capture: true },
    );
    const stopEscape = registerCommands(
      {},
      {
        onKeyDown: (event) => {
          const state = useToolSidebarStore.getState();
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            !state.visible ||
            !state.activeTool ||
            (window.matchMedia("(min-width: 981px)").matches && !state.maximized) ||
            (event.target instanceof Element &&
              event.target.closest(
                'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .monaco-editor, .cm-editor, .xterm, [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
              )) ||
            Array.from(
              document.querySelectorAll(
                '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
              ),
            ).some((popup) => popup.checkVisibility({ checkVisibilityCSS: true }))
          )
            return false;
          state.dispatch({
            type:
              state.maximized && window.matchMedia("(min-width: 981px)").matches
                ? "restore"
                : // Narrow close keeps the tools shown, so widening later still has the rail.
                  "collapse",
          });
          event.preventDefault();
          event.stopPropagation();
        },
      },
    );
    return () => {
      stopObserving();
      stopCommands();
      stopEscape();
      stopMenu();
    };
  });

  return (
    <div
      ref={commandsRef}
      className="relative flex min-h-0 min-w-0 flex-1"
      data-tool-sidebar-layout
      style={
        {
          "--tools-sidebar-width": `${visible && isWide ? TOOL_SIDEBAR_RAIL_WIDTH + (activeTool ? pageWidth : 0) : 0}px`,
          "--tools-rail-width": `${TOOL_SIDEBAR_RAIL_WIDTH}px`,
        } as CSSProperties
      }
    >
      <div
        ref={setTitlebarHost}
        data-workspace-titlebar
        inert={(maximized && isWide) || undefined}
        className={cn(
          "absolute inset-x-0 top-0 z-10 h-[var(--workspace-topbar-height)] bg-background",
          isElectron && "drag-region",
          maximized && isWide && "[&>*]:invisible",
        )}
      />
      <div
        className={cn("flex min-h-0 min-w-0 flex-1", maximized && isWide && "invisible")}
        inert={(maximized && isWide) || undefined}
      >
        <WorkspaceTitlebarHost value={titlebarHost}>
          <WorkspaceTitlebarControlsHost value={titlebarControlsHost}>
            {children}
          </WorkspaceTitlebarControlsHost>
        </WorkspaceTitlebarHost>
      </div>
      <div
        className={cn(
          "pointer-events-auto fixed top-[var(--workspace-controls-top)] right-[var(--workspace-tools-controls-right)] z-30 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]",
          mobileSidebarSheetMounted && "hidden",
        )}
      >
        <DropdownTerminalButton />
        <div ref={setTitlebarControlsHost} className="flex" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={
                  statusAlert && !visible
                    ? `Toggle tools sidebar (status ${statusAlert === "fail" ? "failing" : "warning"})`
                    : "Toggle tools sidebar"
                }
                aria-pressed={visible && (isWide || activeTool !== null)}
                aria-controls="tools-sidebar"
                size="icon-sm"
                variant="ghost"
                onClick={toggle}
              />
            }
          >
            <span className="relative flex">
              <PanelRight className="size-4" />
              {!visible && statusAlert ? <ToolStatusDot state={statusAlert} /> : null}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Toggle tools sidebar{shortcut ? ` (${shortcut})` : ""}
          </TooltipPopup>
        </Tooltip>
      </div>
      {visible && (isWide || activeTool) ? (
        <aside
          id="tools-sidebar"
          aria-label="Tools sidebar"
          data-tool-sidebar-state={activeTool ? (maximized ? "maximized" : "expanded") : "rail"}
          className={cn(
            "workspace-tools-panel mt-[var(--workspace-topbar-height)] flex min-h-0 shrink-0 border-l bg-sidebar max-[981px]:absolute max-[981px]:inset-y-0 max-[981px]:right-0 max-[981px]:z-30 max-[981px]:shadow-xl",
            maximized &&
              isWide &&
              "absolute inset-x-0 bottom-0 top-[var(--workspace-topbar-height)] z-40 mt-0",
          )}
        >
          {activeTool ? (
            <ToolSidebarPage maximized={isWide && maximized} width={pageWidth} />
          ) : null}
          <nav
            aria-label="Tools"
            className="hidden min-[981px]:flex w-(--tools-rail-width) shrink-0 flex-col items-center gap-2 py-2"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Calendar"
                    aria-pressed={activeTool === "calendar"}
                    size="icon-sm"
                    variant="ghost-toggle"
                    onClick={() => dispatch({ type: "select", tool: "calendar" })}
                  />
                }
              >
                <CalendarIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="left">Calendar</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Status"
                    aria-description={
                      statusAlert
                        ? `Status sources ${statusAlert === "fail" ? "failing" : "warning"}`
                        : undefined
                    }
                    aria-pressed={activeTool === "status"}
                    size="icon-sm"
                    variant="ghost-toggle"
                    onClick={() => dispatch({ type: "select", tool: "status" })}
                  />
                }
              >
                <span className="relative flex">
                  <ActivityIcon className="size-4" />
                  {statusAlert ? <ToolStatusDot state={statusAlert} /> : null}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="left">
                Status{statusAlert ? ` · ${statusAlert === "fail" ? "Failing" : "Warning"}` : ""}
              </TooltipPopup>
            </Tooltip>
          </nav>
        </aside>
      ) : null}
    </div>
  );
}

function ToolSidebarPage({ maximized, width }: { maximized: boolean; width: number }) {
  const { activeTool, dispatch } = useToolSidebarStore();
  const title = activeTool === "status" ? "Status" : "Calendar";
  const resize = useResizeDrag<HTMLButtonElement>((event) => {
    const pane = event.currentTarget.parentElement;
    if (!pane || maximized) return null;
    const max = resolveToolSidebarWidth(
      600,
      pane.closest("[data-tool-sidebar-layout]")?.clientWidth ?? 924,
    );
    return {
      width: pane.getBoundingClientRect().width,
      edge: "left",
      bounds: { min: 280, max },
      resize(nextWidth) {
        pane.style.width = `${nextWidth}px`;
        return nextWidth;
      },
      finish(nextWidth) {
        dispatch({ type: "resize", width: nextWidth });
      },
      cleanup() {
        pane.style.width = `${width}px`;
      },
    };
  });
  return (
    <div
      {...workspaceAreaProps("tools", 5, title)}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col border-r bg-background",
        maximized && "flex-1",
      )}
      style={maximized ? undefined : { width, maxWidth: "100vw" }}
    >
      {!maximized ? (
        <button
          aria-label="Resize tools sidebar"
          className="hidden min-[981px]:block absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-border focus-visible:bg-border"
          {...resize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            dispatch({ type: "resize", width: width + (event.key === "ArrowLeft" ? 20 : -20) });
          }}
          onDoubleClick={() => dispatch({ type: "resize", width: 300 })}
        />
      ) : null}
      <header className="flex h-10 shrink-0 items-center gap-1 border-b px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        <nav aria-label="Tools" className="flex gap-1 min-[981px]:hidden">
          <Button
            size="icon-micro"
            variant="ghost-toggle"
            aria-label="Calendar"
            aria-pressed={activeTool === "calendar"}
            onClick={() => {
              if (activeTool !== "calendar") dispatch({ type: "select", tool: "calendar" });
            }}
          >
            <CalendarIcon />
          </Button>
          <Button
            size="icon-micro"
            variant="ghost-toggle"
            aria-label="Status"
            aria-pressed={activeTool === "status"}
            onClick={() => {
              if (activeTool !== "status") dispatch({ type: "select", tool: "status" });
            }}
          >
            <ActivityIcon />
          </Button>
        </nav>
        <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger
              className="max-[981px]:hidden"
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-toggle"
                  aria-pressed={maximized}
                  aria-label={
                    maximized
                      ? `Restore ${title.toLowerCase()} size`
                      : `Maximize ${title.toLowerCase()}`
                  }
                  onClick={() => dispatch({ type: "maximize" })}
                />
              }
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </TooltipTrigger>
            <TooltipPopup>
              {maximized
                ? `Restore ${title.toLowerCase()} size`
                : `Maximize ${title.toLowerCase()}`}
            </TooltipPopup>
          </Tooltip>
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label={`Collapse ${title.toLowerCase()}`}
            onClick={() => {
              dispatch({ type: "collapse" });
              document.querySelector<HTMLButtonElement>(`button[aria-label="${title}"]`)?.focus();
            }}
          >
            <X />
          </Button>
        </div>
      </header>
      {activeTool === "status" ? <StatusTool /> : <CalendarTool />}
    </div>
  );
}

function ToolStatusDot({ state }: { state: "fail" | "warn" }) {
  return (
    <span className="pointer-events-none absolute -right-1 -top-1 flex rounded-full bg-sidebar p-px">
      <StatusSourceDot state={state} />
    </span>
  );
}

function StatusTool() {
  const { groups } = useStatusSignal();
  const navigate = useNavigate();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {groups.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">
          Connect to a server that supports status sources.
          <Button variant="ghost" size="xs" render={<Link to="/settings/status-sources" />}>
            <Settings2Icon /> Status source settings
          </Button>
        </p>
      ) : (
        <StatusSourcesList
          groups={groups}
          onConfigureSources={(machine) =>
            void navigate({ to: "/settings/status-sources", search: { machine } })
          }
        />
      )}
    </div>
  );
}
