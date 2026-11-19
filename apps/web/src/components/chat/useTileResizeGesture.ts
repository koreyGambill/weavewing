import { leaderEnabled, isMacPlatform } from "@t3tools/shared/keybindings";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { selectThreadTileLayout, useRightPanelStore } from "../../rightPanelStore";
import {
  resizeTileSplits,
  resizeTileRatio,
  tileGeometry,
  displayTileRoot,
} from "../../threadTileGeometry";
import {
  isLeaderSequenceEvent,
  registerCommands,
  registerMenuAction,
} from "../../shortcuts/dispatcher";
import type { TileNode } from "../../threadTileLayout";
import type { TileSurfaceActions } from "../SurfaceTabContent";
import { ownsTileInput } from "./ThreadTileWorkspace.logic";

type Point = { x: number; y: number };
export function useTileResizeGesture(input: {
  rootRef: RefObject<HTMLDivElement | null>;
  threadRef: ScopedThreadRef;
  panels: Pick<TileSurfaceActions, "keybindings" | "getShortcutContext">;
  overlay: boolean;
}) {
  const [preview, setPreview] = useState<Array<{ splitId: string; ratio: number }> | null>(null);
  const pointer = useRef<Point | null>(null);
  const session = useRef<{
    origin: Point | null;
    root: TileNode;
    groupId: string;
    splits: ReturnType<typeof resizeTileSplits>;
    ratios: Array<{ splitId: string; ratio: number }>;
    key: string | null;
    releaseKey: string | null;
    latched: boolean;
    modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
  } | null>(null);
  const { environmentId, threadId } = input.threadRef;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the held keyboard gesture and window pointer, release, blur, and visibility listeners
  useEffect(() => {
    const threadRef = { environmentId, threadId };
    const finish = (commit: boolean) => {
      const current = session.current;
      if (!current) return;
      session.current = null;
      if (commit)
        for (const change of current.ratios)
          useRightPanelStore
            .getState()
            .applyTileAction(
              threadRef,
              change.splitId === "focus-pair-split"
                ? { type: "resize-focus-pair", ratio: change.ratio }
                : { type: "resize", ...change },
            );
      setPreview(null);
    };
    const normalized = (point: Point) => {
      const bounds = input.rootRef.current?.getBoundingClientRect();
      return bounds && bounds.width > 0 && bounds.height > 0
        ? { x: (point.x - bounds.left) / bounds.width, y: (point.y - bounds.top) / bounds.height }
        : null;
    };
    const begin = (event?: KeyboardEvent) => {
      if (session.current || event?.repeat) return;
      const layout = selectThreadTileLayout(useRightPanelStore.getState().byThreadKey, threadRef);
      if (layout.maximizedGroupId) return;
      const focused = tileGeometry(displayTileRoot(layout)).groups.find(
        (group) => group.id === layout.focusedGroupId,
      );
      if (!focused) return;
      const origin = event && pointer.current ? normalized(pointer.current) : null;
      const splits = resizeTileSplits(
        displayTileRoot(layout),
        layout.focusedGroupId,
        origin ?? {
          x: focused.rect.x + focused.rect.width / 2,
          y: focused.rect.y + focused.rect.height / 2,
        },
      );
      if (!splits.length) return;
      const shortcut = input.panels.keybindings.find(
        (rule) => rule.command === "workspace.tile.resize",
      )?.shortcut;
      const mac = isMacPlatform(navigator.platform);
      session.current = {
        origin,
        root: displayTileRoot(layout),
        groupId: layout.focusedGroupId,
        splits,
        ratios: splits.map((split) => ({ splitId: split.id, ratio: split.ratio })),
        key: event?.code ?? null,
        releaseKey: shortcut?.key ?? null,
        latched: event ? isLeaderSequenceEvent(event) : leaderEnabled(input.panels.keybindings),
        modifiers: {
          ctrl: event?.ctrlKey ?? Boolean(shortcut?.ctrlKey || (shortcut?.modKey && !mac)),
          alt: event?.altKey ?? shortcut?.altKey ?? false,
          shift: event?.shiftKey ?? shortcut?.shiftKey ?? false,
          meta: event?.metaKey ?? Boolean(shortcut?.metaKey || (shortcut?.modKey && mac)),
        },
      };
      setPreview(session.current.ratios);
    };
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      const current = session.current;
      if (!current) return;
      const point = normalized(pointer.current);
      if (!point) return;
      if (current.origin === null) {
        current.origin = point;
        current.splits = resizeTileSplits(current.root, current.groupId, point);
      }
      const delta = { x: point.x - current.origin.x, y: point.y - current.origin.y };
      current.ratios = current.splits.map((split) => ({
        splitId: split.id,
        ratio: resizeTileRatio(split, delta),
      }));
      setPreview(current.ratios);
      event.preventDefault();
    };
    const keydown = (event: KeyboardEvent) => {
      const current = session.current;
      if (!current) return false;
      if (event.key === "Escape") finish(false);
      else if (event.key === "Enter") finish(true);
      else if (event.key.startsWith("Arrow") || /^[hjkl]$/.test(event.key)) {
        const axis = ["ArrowLeft", "ArrowRight", "h", "l"].includes(event.key)
          ? "horizontal"
          : "vertical";
        const amount =
          (["ArrowLeft", "ArrowUp", "h", "k"].includes(event.key) ? -1 : 1) *
          (event.shiftKey ? 0.01 : 0.03);
        current.splits = current.splits.map((split) =>
          split.axis === axis
            ? { ...split, ratio: Math.max(0.1, Math.min(0.9, split.ratio + amount)) }
            : split,
        );
        current.origin = pointer.current ? normalized(pointer.current) : null;
        current.ratios = current.splits.map((split) => ({ splitId: split.id, ratio: split.ratio }));
        setPreview(current.ratios);
      }
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    const release = (event: KeyboardEvent) => {
      const current = session.current;
      if (!current || current.latched) return;
      if (
        (current.key === null
          ? event.key.toLowerCase() === current.releaseKey
          : event.code === current.key) ||
        (current.modifiers.ctrl && !event.ctrlKey) ||
        (current.modifiers.alt && !event.altKey) ||
        (current.modifiers.shift && !event.shiftKey) ||
        (current.modifiers.meta && !event.metaKey)
      )
        finish(true);
    };
    const cancel = () => finish(false);
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const step = (key: "h" | "j" | "k" | "l") => {
      begin();
      if (!session.current) return;
      keydown(new KeyboardEvent("keydown", { key }));
      finish(true);
    };
    const unregister = registerCommands(
      {
        "workspace.tile.resizeLeft": (event) => {
          event.preventDefault();
          event.stopPropagation();
          step("h");
        },
        "workspace.tile.resizeDown": (event) => {
          event.preventDefault();
          event.stopPropagation();
          step("j");
        },
        "workspace.tile.resizeUp": (event) => {
          event.preventDefault();
          event.stopPropagation();
          step("k");
        },
        "workspace.tile.resizeRight": (event) => {
          event.preventDefault();
          event.stopPropagation();
          step("l");
        },
        "workspace.tile.resize": (event) => {
          event.preventDefault();
          event.stopPropagation();
          begin(event);
        },
      },
      {
        capture: true,
        keybindings: () => input.panels.keybindings,
        context: input.panels.getShortcutContext,
        onKeyDown: keydown,
        when: (event) =>
          !event.isComposing &&
          !(
            event.target instanceof Element &&
            event.target.closest('[role="dialog"], [role="alertdialog"], [data-keybinding-capture]')
          ) &&
          ownsTileInput(input.rootRef.current, event.target, input.overlay),
      },
    );
    const owned = (run: () => void) => () =>
      ownsTileInput(input.rootRef.current, document.activeElement, input.overlay) ? run() : false;
    const unsteps = (
      [
        ["workspace.tile.resizeLeft", "h"],
        ["workspace.tile.resizeDown", "j"],
        ["workspace.tile.resizeUp", "k"],
        ["workspace.tile.resizeRight", "l"],
      ] as const
    ).map(([command, key]) =>
      registerMenuAction(
        command,
        owned(() => step(key)),
      ),
    );
    const unmenu = registerMenuAction(
      "workspace.tile.resize",
      owned(() => begin()),
    );
    // Ends the held resize wherever it started.
    const unrelease = registerMenuAction("workspace.tile.resize.release", () =>
      session.current ? finish(true) : false,
    );
    window.addEventListener("pointermove", move, true);
    window.addEventListener("keyup", release, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      unregister();
      unmenu();
      for (const unregisterStep of unsteps) unregisterStep();
      unrelease();
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("keyup", release, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
      finish(false);
    };
  }, [
    input.rootRef,
    environmentId,
    threadId,
    input.panels.keybindings,
    input.panels.getShortcutContext,
    input.overlay,
  ]);
  return preview;
}
