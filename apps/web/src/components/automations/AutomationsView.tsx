import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { PlusIcon, SettingsIcon } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { ToolFilterInput } from "../ThreadToolViews";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AutomationDetail } from "./AutomationDetail";
import { EnvironmentAutomations } from "./AutomationList";
import type { AutomationScope } from "./automationsView.logic";
import { automationRowKey, useThreadContext } from "./useAutomations";

function backToList(list: RefObject<HTMLDivElement | null>, rowKey: string | null) {
  useThreadContextSidebarStore.getState().selectAutomation(null);
  // Focus the row that opened the detail once the list has rendered again.
  requestAnimationFrame(() => {
    Array.from(list.current?.querySelectorAll<HTMLElement>("[data-automation-row]") ?? [])
      .find((element) => element.dataset.automationRow === rowKey)
      ?.focus();
  });
}

export function AutomationsView({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const thread = useThreadContext(threadRef);
  const storedScope = useThreadContextSidebarStore((state) => state.automationScope);
  const selection = useThreadContextSidebarStore((state) => state.automationSelection);
  const [filter, setFilter] = useState("");
  const [showPaused, setShowPaused] = useState(true);
  const connected = useConnectedEnvironmentIds();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const scope: AutomationScope =
    storedScope === null || (storedScope !== "server" && thread === null)
      ? thread === null
        ? "server"
        : "thread"
      : storedScope;
  const environmentIds =
    scope === "server" || threadRef === null ? connected : [threadRef.environmentId];
  const newEnvironmentId = threadRef?.environmentId ?? connected[0];
  const selectedKey =
    selection === null ? null : automationRowKey(selection.environmentId, selection.taskId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape leaves the detail from anywhere in the sidebar, including after focus fell back to the page.
  useEffect(() => {
    if (selectedKey === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      const inSidebar = target === null || target === document.body;
      if (!inSidebar && !target?.closest('[data-slot="sidebar"]')) return;
      // Menus and dialogs close themselves first.
      if (target?.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      backToList(listRef, selectedKey);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedKey]);

  if (selection !== null) {
    return (
      <AutomationDetail
        environmentId={selection.environmentId as EnvironmentId}
        taskId={selection.taskId}
        thread={thread}
        onBack={() => backToList(listRef, selectedKey)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-2.5 pt-2.5 pb-2">
        <ToggleGroup
          aria-label="Automation scope"
          size="segmented-compact"
          className="w-full *:flex-1"
          value={[scope]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "thread" || next === "project" || next === "server") {
              useThreadContextSidebarStore.getState().setAutomationScope(next);
            }
          }}
        >
          <Toggle value="thread" disabled={thread === null}>
            Thread
          </Toggle>
          <Toggle value="project" disabled={thread === null}>
            Project
          </Toggle>
          <Toggle value="server">Server</Toggle>
        </ToggleGroup>
        <ToggleGroup
          aria-label="Automation status"
          size="segmented-compact"
          className="w-full *:flex-1"
          value={[showPaused ? "all" : "active"]}
          onValueChange={(value) => {
            if (value[0]) setShowPaused(value[0] === "all");
          }}
        >
          <Toggle value="all">All</Toggle>
          <Toggle value="active">Active</Toggle>
        </ToggleGroup>
        <ToolFilterInput label="Filter automations" value={filter} onChange={setFilter}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="New automation"
                  disabled={newEnvironmentId === undefined}
                  onClick={() =>
                    void navigate({
                      to: "/settings/scheduled-tasks",
                      search: {
                        ...(newEnvironmentId ? { environmentId: newEnvironmentId } : {}),
                        new: true,
                      },
                    })
                  }
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup>New automation</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Automation settings"
                  onClick={() =>
                    void navigate({
                      to: "/settings/scheduled-tasks",
                      search: newEnvironmentId ? { environmentId: newEnvironmentId } : {},
                    })
                  }
                />
              }
            >
              <SettingsIcon />
            </TooltipTrigger>
            <TooltipPopup>Automation settings</TooltipPopup>
          </Tooltip>
        </ToolFilterInput>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 pb-2.5 text-xs">
        {environmentIds.map((environmentId) => (
          <EnvironmentAutomations
            key={environmentId}
            environmentId={environmentId}
            grouped={environmentIds.length > 1}
            scope={scope}
            thread={thread}
            filter={filter}
            showPaused={showPaused}
          />
        ))}
      </div>
    </div>
  );
}
