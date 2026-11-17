import { useAtomValue } from "@effect/atom-react";
import { CalendarIcon, Maximize2, Minimize2, PanelRight, X } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { isElectron } from "../env";
import { useResizeDrag } from "../hooks/useResizeDrag";
import { shortcutLabelForCommand } from "../keybindings";
import { cn } from "../lib/utils";
import { observeResize } from "../lib/observeResize";
import { resolveToolSidebarWidth } from "./ToolSidebar.logic";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useToolSidebarStore } from "../toolSidebarStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { CalendarTool } from "./CalendarTool";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ToolSidebarLayout({ children }: { children: ReactNode }) {
  const { visible, activeTool, width, maximized, dispatch } = useToolSidebarStore();
  const [availableWidth, setAvailableWidth] = useState(1280);
  const pageWidth = resolveToolSidebarWidth(width, availableWidth);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isWide = useMediaQuery("(min-width: 768px)");
  const shortcut = shortcutLabelForCommand(keybindings, "toolSidebar.toggle");
  const [commandsRef] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    const stopObserving = observeResize(node, () => setAvailableWidth(node.clientWidth));
    setAvailableWidth(node.clientWidth);
    const stopMenu = registerMenuAction("toolSidebar.toggle", () => {
      if (window.matchMedia("(min-width: 768px)").matches)
        useToolSidebarStore.getState().dispatch({ type: "toggle" });
    });
    const stopCommands = registerCommands(
      {
        "toolSidebar.toggle": (event) => {
          event.preventDefault();
          event.stopPropagation();
          useToolSidebarStore.getState().dispatch({ type: "toggle" });
        },
      },
      {
        capture: true,
        when: (event) =>
          window.matchMedia("(min-width: 768px)").matches &&
          !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]")),
        onKeyDown: (event) => {
          const state = useToolSidebarStore.getState();
          if (
            event.key !== "Escape" ||
            !state.maximized ||
            document.querySelector('[role="dialog"], [role="alertdialog"]')
          )
            return false;
          state.dispatch({ type: "restore" });
          if (
            node.contains(document.activeElement) &&
            document.activeElement instanceof HTMLElement
          )
            document.activeElement.blur();
          event.preventDefault();
          event.stopPropagation();
        },
      },
    );
    return () => {
      stopObserving();
      stopCommands();
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
          "--tools-sidebar-width": `${visible ? 44 + (activeTool ? pageWidth : 0) : 0}px`,
        } as CSSProperties
      }
    >
      <div
        className={cn("flex min-h-0 min-w-0 flex-1", maximized && "md:invisible")}
        inert={(maximized && isWide) || undefined}
      >
        {children}
      </div>
      <div className="pointer-events-auto fixed top-[var(--workspace-controls-top)] right-[var(--workspace-tools-controls-right)] z-50 hidden h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag] md:flex">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Toggle tools sidebar"
                aria-pressed={visible}
                aria-controls="tools-sidebar"
                size="icon-sm"
                variant="ghost"
                onClick={() => dispatch({ type: "toggle" })}
              />
            }
          >
            <PanelRight className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Toggle tools sidebar{shortcut ? ` (${shortcut})` : ""}
          </TooltipPopup>
        </Tooltip>
      </div>
      {visible ? (
        <aside
          id="tools-sidebar"
          aria-label="Tools sidebar"
          data-tool-sidebar-state={activeTool ? (maximized ? "maximized" : "expanded") : "rail"}
          className={cn(
            "hidden min-h-0 shrink-0 border-l bg-sidebar md:flex",
            maximized && "absolute inset-0 z-40",
          )}
        >
          {activeTool ? <ToolSidebarPage maximized={maximized} width={pageWidth} /> : null}
          <nav
            aria-label="Tools"
            style={{ paddingTop: "var(--workspace-topbar-height)" }}
            className="flex w-11 shrink-0 flex-col items-center gap-2 border-l"
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
          </nav>
        </aside>
      ) : null}
    </div>
  );
}

function ToolSidebarPage({ maximized, width }: { maximized: boolean; width: number }) {
  const dispatch = useToolSidebarStore((state) => state.dispatch);
  const resize = useResizeDrag<HTMLButtonElement>((event) => {
    const pane = event.currentTarget.parentElement;
    if (!pane || maximized) return null;
    const max = Math.max(
      280,
      Math.min(600, (pane.closest("[data-tool-sidebar-layout]")?.clientWidth ?? 924) - 364),
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
      {...workspaceAreaProps("tools", 5, "Calendar")}
      className={cn("relative flex min-h-0 min-w-0 flex-col bg-background", maximized && "flex-1")}
      style={maximized ? undefined : { width, maxWidth: "calc(100vw - 44px)" }}
    >
      {!maximized ? (
        <button
          aria-label="Resize tools sidebar"
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-border focus-visible:bg-border"
          {...resize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            dispatch({ type: "resize", width: width + (event.key === "ArrowLeft" ? 20 : -20) });
          }}
          onDoubleClick={() => dispatch({ type: "resize", width: 300 })}
        />
      ) : null}
      <header
        style={{ paddingRight: "calc(var(--workspace-native-controls-inset) + 0.5rem)" }}
        className={cn(
          "flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 border-b pl-3 pr-2",
          isElectron && "drag-region",
          maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Calendar</h2>
        <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-toggle"
                  aria-pressed={maximized}
                  aria-label={maximized ? "Restore calendar size" : "Maximize calendar"}
                  onClick={() => dispatch({ type: "maximize" })}
                />
              }
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </TooltipTrigger>
            <TooltipPopup>{maximized ? "Restore calendar size" : "Maximize calendar"}</TooltipPopup>
          </Tooltip>
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label="Collapse calendar"
            onClick={() => {
              dispatch({ type: "collapse" });
              document.querySelector<HTMLButtonElement>('button[aria-label="Calendar"]')?.focus();
            }}
          >
            <X />
          </Button>
        </div>
      </header>
      <CalendarTool />
    </div>
  );
}
