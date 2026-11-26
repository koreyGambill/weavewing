import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@t3tools/contracts";
import type { ReactNode } from "react";

import type { PopoverPopup } from "../ui/popover";

/**
 * One item in the row under the composer, which shows items in array order with the thread
 * menu (⋯) at the right end and decides per width whether each renders in the row or in ⋯.
 * A ⋯ row calls `openPopover()` to open the item's `popover` anchored to ⋯.
 */
export type ComposerRowItem = ComposerRowLeavingItem | ComposerRowStayingItem;

/** An item that leaves whole into ⋯ when the row runs out of width, so it needs a ⋯ row. */
export interface ComposerRowLeavingItem extends ComposerRowItemBase {
  /** Items leave from the lowest number up. See `COMPOSER_ROW_PRIORITY`. */
  readonly priority: number;
  readonly renderMenuRow: (menu: ComposerRowMenuRow) => ReactNode;
}

/** An item that stays in the row at every width, or one that lives only in ⋯. */
export interface ComposerRowStayingItem extends ComposerRowItemBase {
  readonly priority: null;
  /** Required for an item that lives only in ⋯, which has no `renderRowItem`. */
  readonly renderMenuRow?: (menu: ComposerRowMenuRow) => ReactNode;
}

interface ComposerRowItemBase {
  /** Unique in the row; written to the item's `data-composer-row-item` attribute. */
  readonly id: string;
  /** Leaves the item out of both the row and ⋯. */
  readonly hidden?: boolean;
  /**
   * Whether the item's labels shorten before any item leaves. Labels are the item's
   * `ComposerContextLabel`s, which shorten down to `COMPOSER_ROW_LABEL_MIN_PX`.
   */
  readonly shrinks?: boolean;
  /** Starts the row's right end, just before ⋯. Only an item that stays in the row may set it. */
  readonly endAligned?: boolean;
  /**
   * The item as it sits in the row. Omit it for an entry that lives only in ⋯.
   * While the item sits in ⋯ the row keeps this mounted, invisible and inert, so its
   * width stays measurable and its own popup can still open; such popups read
   * `useComposerRowItemPlacement()` to anchor to ⋯ and return focus there.
   */
  readonly renderRowItem?: () => ReactNode;
  /**
   * Opens the item's own popup while it sits in ⋯, for a keyboard shortcut that targets the
   * item's control there. The popup anchors to ⋯ and returns focus to where it was.
   */
  readonly openPopup?: () => void;
  /** The popover `openPopover()` opens from ⋯, anchored to the ⋯ button. */
  readonly popover?: ComposerRowItemPopover;
}

export interface ComposerRowItemPopover {
  /** The popover's accessible name. */
  readonly label: string;
  readonly width?: Parameters<typeof PopoverPopup>[0]["width"];
  readonly render: (close: () => void) => ReactNode;
}

export interface ComposerRowMenuRow {
  /**
   * Closes ⋯ and opens the item's popup anchored to the ⋯ button, with focus returning to
   * that button when the popup closes. With no argument it opens the item's `popover`;
   * pass `open` for an item whose popup belongs to its own control, such as a select.
   */
  readonly openPopover: (open?: () => void) => void;
  /**
   * Put on the element that shows the item's value. While the row is open, the item's
   * control can render its own live value there through `useComposerRowItemPlacement()`,
   * so the ⋯ row and the control cannot disagree.
   */
  readonly setValueElement: (element: HTMLElement | null) => void;
}

/** Dispatched on an item's control while it sits in ⋯, to open its popup from a shortcut. */
export const COMPOSER_ROW_OPEN_EVENT = "composer-row-open";

/**
 * Opens the control a shortcut targets when that control sits in the row's thread menu.
 * Returns whether one did.
 */
export function openComposerRowControl(
  scope: ParentNode | null | undefined,
  command: string,
): boolean {
  const trigger = scope?.querySelector(
    `[data-in-menu] button[data-composer-shortcut~="${command}"]`,
  );
  trigger?.dispatchEvent(new Event(COMPOSER_ROW_OPEN_EVENT, { bubbles: true }));
  return trigger != null;
}

/** Leave order: lower numbers leave into ⋯ first. Agents, diff and location never leave. */
export const COMPOSER_ROW_PRIORITY = {
  automation: 10,
  tools: 20,
  computer: 30,
  pullRequest: 40,
  branch: 50,
} as const;

/** The narrowest a shrinking item's label gets before items start leaving. */
export const COMPOSER_ROW_LABEL_MIN_PX = 96;

// Bringing an item back needs this much slack, so the row does not flap at the boundary.
const COMPOSER_ROW_RETURN_HYSTERESIS_PX = 16;

export interface ComposerRowItemWidth {
  readonly id: string;
  readonly priority: number | null;
  /** Width with full labels. */
  readonly natural: number;
  /** Width with shrinking labels at their minimum; equal to `natural` for other items. */
  readonly minimum: number;
}

/** The ids of the items that leave into ⋯ at this width, in leave order. */
export function resolveComposerRowHiddenIds(input: {
  readonly items: ReadonlyArray<ComposerRowItemWidth>;
  readonly availableWidth: number;
  readonly gap: number;
  readonly menuWidth: number;
  readonly previousHiddenIds: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const leavers = input.items
    .map((item, index) => ({ item, index }))
    .flatMap(({ item, index }) =>
      item.priority === null ? [] : [{ id: item.id, priority: item.priority, index }],
    )
    .toSorted((a, b) => a.priority - b.priority || b.index - a.index)
    .map(({ id }) => id);
  const previousCount = input.previousHiddenIds.length;
  const requiredWidth = (hiddenCount: number) => {
    const hidden = new Set(leavers.slice(0, hiddenCount));
    const shown = input.items.filter((item) => !hidden.has(item.id));
    // Every shown item is followed by a gap: the next item's, or the menu's.
    return shown.reduce((sum, item) => sum + item.minimum + input.gap, input.menuWidth);
  };
  let hiddenCount = 0;
  while (
    hiddenCount < leavers.length &&
    requiredWidth(hiddenCount) >
      input.availableWidth - (hiddenCount < previousCount ? COMPOSER_ROW_RETURN_HYSTERESIS_PX : 0)
  ) {
    hiddenCount += 1;
  }
  return leavers.slice(0, hiddenCount);
}

export interface ComposerRowAgentsSummary {
  readonly working: number;
  readonly failed: number;
  /** Completed. */
  readonly done: number;
  /** Ended any other way, such as cancelled or interrupted. */
  readonly past: number;
  readonly tone: "working" | "failed" | "idle";
  /** "2 working", "1 failed", "3 done", or "3 past" once any ended without completing. */
  readonly label: string;
  /** The label's number, shown alone at phone widths. */
  readonly count: number;
  /** The label's word: "working", "failed", "done" or "past". */
  readonly word: string;
  /** Every count, for the tooltip and accessible name. */
  readonly description: string;
}

/** What the Agents item shows, or null when the thread never delegated. */
export function summarizeComposerRowAgents(
  agents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">> | undefined,
): ComposerRowAgentsSummary | null {
  let working = 0;
  let failed = 0;
  let done = 0;
  let past = 0;
  for (const { status } of agents ?? []) {
    if (isOrchestrationV2WorkActive(status)) working += 1;
    else if (status === "failed") failed += 1;
    else if (status === "completed") done += 1;
    else past += 1;
  }
  if (working + failed + done + past === 0) return null;
  const tone = working > 0 ? "working" : failed > 0 ? "failed" : "idle";
  const count = tone === "working" ? working : tone === "failed" ? failed : done + past;
  const word =
    tone === "working" ? "working" : tone === "failed" ? "failed" : past > 0 ? "past" : "done";
  const parts = [
    working > 0 ? `${working} working` : null,
    failed > 0 ? `${failed} failed` : null,
    done > 0 ? `${done} done` : null,
    past > 0 ? `${past} past` : null,
  ].filter((part) => part !== null);
  return {
    working,
    failed,
    done,
    past,
    tone,
    label: `${count} ${word}`,
    count,
    word,
    description: `Agents: ${parts.join(", ")}`,
  };
}
