import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ListFilterIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { useThreadContextSidebarStore } from "../../threadContextSidebarStore";
import { ToolFilterInput } from "../ThreadToolViews";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AutomationDetail } from "./AutomationDetail";
import { EnvironmentAutomationHistory } from "./AutomationHistory";
import { EnvironmentAutomations } from "./AutomationList";
import type { AutomationStatusFilter } from "./automationsView.logic";
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
  const selection = useThreadContextSidebarStore((state) => state.automationSelection);
  const [view, setView] = useState<"manage" | "history">("manage");
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<AutomationStatusFilter>("all");
  const [onlyThread, setOnlyThread] = useState(false);
  const connected = useConnectedEnvironmentIds();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const threadFilter = onlyThread ? thread : null;
  const environmentIds =
    threadFilter !== null && threadRef !== null ? [threadRef.environmentId] : connected;
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
      <div className="px-2.5 pt-2.5">
        <ToggleGroup
          aria-label="Automation view"
          size="segmented-compact"
          className="w-full *:flex-1"
          value={[view]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "manage" || next === "history") setView(next);
          }}
        >
          <Toggle value="manage">Manage</Toggle>
          <Toggle value="history">Run history</Toggle>
        </ToggleGroup>
      </div>
      {view === "history" ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 py-2.5 text-xs">
          {connected.length === 0 ? (
            <p className="text-muted-foreground">No connected servers.</p>
          ) : null}
          {connected.map((environmentId) => (
            <EnvironmentAutomationHistory
              key={environmentId}
              environmentId={environmentId}
              grouped={connected.length > 1}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 px-2.5 pt-2 pb-2">
            <div className="min-w-0 flex-1">
              <ToolFilterInput label="Filter automations" value={filter} onChange={setFilter} />
            </div>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant={status !== "all" || threadFilter !== null ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Automation filters"
                  />
                }
              >
                <ListFilterIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuRadioGroup
                  value={status}
                  onValueChange={(value) => {
                    if (value === "all" || value === "active" || value === "paused")
                      setStatus(value);
                  }}
                >
                  <MenuRadioItem value="all">All statuses</MenuRadioItem>
                  <MenuRadioItem value="active">Active</MenuRadioItem>
                  <MenuRadioItem value="paused">Paused</MenuRadioItem>
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuCheckboxItem
                  checked={threadFilter !== null}
                  disabled={thread === null}
                  onCheckedChange={setOnlyThread}
                >
                  Applies to this thread
                </MenuCheckboxItem>
              </MenuPopup>
            </Menu>
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
          </div>
          <div
            ref={listRef}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2.5 pb-2.5 text-xs"
          >
            {environmentIds.length === 0 ? (
              <p className="text-muted-foreground">No connected servers.</p>
            ) : null}
            {environmentIds.map((environmentId) => (
              <EnvironmentAutomations
                key={environmentId}
                environmentId={environmentId}
                grouped={environmentIds.length > 1}
                thread={threadFilter}
                contextThreadId={
                  threadRef?.environmentId === environmentId ? thread?.threadId : undefined
                }
                filter={filter}
                status={status}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
