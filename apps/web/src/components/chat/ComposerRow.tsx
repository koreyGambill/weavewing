import { EllipsisIcon } from "lucide-react";
import { createContext, Fragment, use, useState } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { Menu, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";
import { ComposerSurface } from "./ComposerSurface";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  COMPOSER_ROW_OPEN_EVENT,
  type ComposerRowItem,
  type ComposerRowItemWidth,
  composerRowItemWidth,
  resolveComposerRowHiddenIds,
} from "./composerRowItems";
import { elementOuterWidth } from "./restingComposerControlsMeasurement";

export interface ComposerRowItemPlacement {
  /** True while the item sits in ⋯; the row keeps it mounted, invisible and inert. */
  readonly inMenu: boolean;
  /** The ⋯ button, which a popup opened from ⋯ anchors to. */
  readonly anchor: HTMLElement | null;
  /** Where focus goes when that popup closes: ⋯, or where a shortcut was pressed. */
  readonly finalFocus: () => HTMLElement | null;
  /** The open ⋯ row's value element, for the item to render its live value into. */
  readonly menuValue: HTMLElement | null;
}

type ValueSlots = Readonly<Record<string, HTMLElement>>;
type SetValueSlots = (update: (slots: ValueSlots) => ValueSlots) => void;
const valueElementSetters = new WeakMap<
  SetValueSlots,
  Map<string, (element: HTMLElement | null) => void>
>();

// One callback per item, so React does not detach and reattach the slot on every render.
function valueElementSetterFor(setSlots: SetValueSlots, id: string) {
  const byId = valueElementSetters.get(setSlots) ?? new Map();
  valueElementSetters.set(setSlots, byId);
  const existing = byId.get(id);
  if (existing) return existing;
  const callback = (element: HTMLElement | null) =>
    setSlots((slots) => {
      if ((slots[id] ?? null) === element) return slots;
      const { [id]: _removed, ...rest } = slots;
      return element ? { ...rest, [id]: element } : rest;
    });
  byId.set(id, callback);
  return callback;
}

const ComposerRowItemPlacementContext = createContext<ComposerRowItemPlacement | null>(null);

/** Where the enclosing row item sits; null outside the row, such as in the details panel. */
export function useComposerRowItemPlacement(): ComposerRowItemPlacement | null {
  return use(ComposerRowItemPlacementContext);
}

const ITEM_SELECTOR = ":scope > [data-composer-row-item]";
const LABEL_SELECTOR = "[data-composer-label]";

/** A hidden or squeezed label's scrollWidth loses its tail, so measure its text instead. */
function labelTextWidth(label: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    width += range.getBoundingClientRect().width;
  }
  const motion = label.querySelector<HTMLElement>("[data-composer-label-motion]");
  const maxWidth = motion ? Number.parseFloat(getComputedStyle(motion).maxWidth) : Number.NaN;
  return Number.isFinite(maxWidth) ? Math.min(width, maxWidth) : width;
}

function measureItem(element: HTMLElement, range: Range): ComposerRowItemWidth | null {
  const priority = element.dataset.composerRowPriority;
  return composerRowItemWidth({
    id: element.dataset.composerRowItem!,
    priority: priority === undefined ? null : Number(priority),
    shrinks: element.dataset.composerRowShrinks !== undefined,
    // An end-aligned item's auto margin is the row's free space, not part of the item.
    rendered:
      element.dataset.composerRowEnd === undefined
        ? elementOuterWidth(element)
        : element.getBoundingClientRect().width,
    content: element.scrollWidth,
    labels: Array.from(element.querySelectorAll<HTMLElement>(LABEL_SELECTOR), (label) => ({
      text: labelTextWidth(label, range),
      rendered: label.getBoundingClientRect().width,
    })),
  });
}

/**
 * Decides which items leave into ⋯. The row is measured when it, an item or a label
 * resizes, when its text or children change, and when fonts load. Items in ⋯ stay
 * mounted off-flow, so their full widths are measurable whatever the last decision was.
 */
function useComposerRowHiddenIds(): readonly [
  attach: (element: HTMLDivElement | null) => (() => void) | undefined,
  hiddenIds: ReadonlyArray<string>,
] {
  const [hiddenIds, setHiddenIds] = useState<ReadonlyArray<string>>([]);

  const attach = (row: HTMLDivElement | null) => {
    if (!row) return;
    const measure = () => {
      if (row.clientWidth === 0) return;
      const style = getComputedStyle(row);
      const range = document.createRange();
      const items = Array.from(row.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).flatMap(
        (element) => measureItem(element, range) ?? [],
      );
      const menu = row.querySelector<HTMLElement>("[data-composer-row-menu]");
      // The committed attributes, not render state, so a stale closure cannot misread them.
      const previousHiddenIds = Array.from(
        row.querySelectorAll<HTMLElement>(`${ITEM_SELECTOR}[data-in-menu]`),
        (element) => element.dataset.composerRowItem!,
      );
      const next = resolveComposerRowHiddenIds({
        items,
        availableWidth:
          row.clientWidth -
          (Number.parseFloat(style.paddingInlineStart) || 0) -
          (Number.parseFloat(style.paddingInlineEnd) || 0),
        gap: Number.parseFloat(style.columnGap) || 0,
        // The border box: ⋯'s auto margin is the row's free space, not part of the control.
        menuWidth: menu ? menu.getBoundingClientRect().width : 0,
        previousHiddenIds,
      });
      const unchanged =
        next.length === previousHiddenIds.length &&
        next.every((id) => previousHiddenIds.includes(id));
      if (unchanged) return;
      flushSync(() => setHiddenIds(next));
    };

    let stopResize = () => {};
    const observeSizes = () => {
      stopResize();
      stopResize = observeResize(
        [
          row,
          ...Array.from(row.querySelectorAll(ITEM_SELECTOR)),
          ...Array.from(row.querySelectorAll(LABEL_SELECTOR)),
        ],
        measure,
      );
    };
    observeSizes();
    // Text and control changes alter natural widths without resizing a squeezed label.
    // Only added or removed elements change the observed set; re-subscribing measures.
    const mutations = new MutationObserver((records) => {
      const elementsChanged = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element),
      );
      if (elementsChanged) observeSizes();
      else measure();
    });
    mutations.observe(row, { childList: true, characterData: true, subtree: true });
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopResize();
      mutations.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  };

  return [attach, hiddenIds] as const;
}

/**
 * The row under the composer: each item shows a piece of the thread's state, with the
 * thread menu (⋯) at the right end holding ⋯-only entries and every item that does not
 * fit at this width.
 */
export function ComposerRow({
  items,
  className,
}: {
  readonly items: ReadonlyArray<ComposerRowItem>;
  readonly className?: string;
}) {
  const [attach, hiddenIds] = useComposerRowHiddenIds();
  const [menuButton, setMenuButton] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popoverItemId, setPopoverItemId] = useState<string | null>(null);
  // Set when a ⋯ row hands focus to a popup, so ⋯ does not take it back as it closes.
  const [focusHandedOff, setFocusHandedOff] = useState(false);
  // Where a shortcut was pressed, so its popup returns focus there instead of to ⋯.
  const [shortcutOrigin, setShortcutOrigin] = useState<HTMLElement | null>(null);
  const [valueSlots, setValueSlots] = useState<ValueSlots>({});

  const shown = items.filter((item) => !item.hidden);
  const rowItems = shown.filter((item) => item.renderRowItem !== undefined);
  const hasEndAlignedItem = rowItems.some((item) => item.endAligned);
  const inMenuItems = rowItems.filter((item) => hiddenIds.includes(item.id));
  const menuOnlyItems = shown.filter((item) => item.renderRowItem === undefined);
  const menuHasRows = inMenuItems.length + menuOnlyItems.length > 0;
  const popoverItem = shown.find((item) => item.id === popoverItemId)?.popover;

  const menuRow = (item: ComposerRowItem) =>
    item.renderMenuRow?.({
      openPopover: (open) => {
        setFocusHandedOff(true);
        setShortcutOrigin(null);
        setMenuOpen(false);
        if (open) open();
        else setPopoverItemId(item.id);
      },
      setValueElement: valueElementSetterFor(setValueSlots, item.id),
    });

  return (
    <ComposerSurface.ContextStrip
      ref={attach}
      data-composer-row
      className={cn(
        "gap-1 text-xs font-normal text-foreground/70 dark:text-muted-foreground",
        className,
      )}
    >
      {rowItems.map((item) => {
        const inMenu = hiddenIds.includes(item.id);
        return (
          <div
            key={item.id}
            data-composer-row-item={item.id}
            data-composer-row-priority={item.priority ?? undefined}
            data-composer-row-shrinks={item.shrinks ? "" : undefined}
            data-composer-row-end={item.endAligned ? "" : undefined}
            data-in-menu={inMenu ? "" : undefined}
            aria-hidden={inMenu || undefined}
            inert={inMenu}
            ref={(element) => {
              const openPopup = item.openPopup;
              if (!element || !inMenu || !openPopup) return;
              const open = () => {
                const origin = document.activeElement;
                setShortcutOrigin(origin instanceof HTMLElement ? origin : null);
                openPopup();
              };
              element.addEventListener(COMPOSER_ROW_OPEN_EVENT, open);
              return () => element.removeEventListener(COMPOSER_ROW_OPEN_EVENT, open);
            }}
            className={cn(
              "flex items-center gap-1 empty:hidden",
              item.endAligned && !inMenu && "ms-auto",
              inMenu
                ? "pointer-events-none invisible absolute end-0 top-0"
                : item.shrinks
                  ? "min-w-0"
                  : "shrink-0",
            )}
          >
            <ComposerRowItemPlacementContext
              value={{
                inMenu,
                anchor: menuButton,
                finalFocus: () => shortcutOrigin ?? menuButton,
                menuValue: valueSlots[item.id] ?? null,
              }}
            >
              {item.renderRowItem?.()}
            </ComposerRowItemPlacementContext>
          </div>
        );
      })}
      <div
        data-composer-row-menu
        aria-hidden={!menuHasRows || undefined}
        inert={!menuHasRows}
        className={cn(
          "flex shrink-0",
          !hasEndAlignedItem && "ms-auto",
          !menuHasRows && "invisible",
        )}
      >
        <Menu
          open={menuOpen}
          onOpenChange={(open) => {
            if (open) setFocusHandedOff(false);
            setMenuOpen(open);
          }}
        >
          <Tooltip>
            <TooltipTrigger render={<span className="flex" />}>
              <MenuTrigger
                ref={setMenuButton}
                render={<ComposerControl size="xs" aria-label="Thread menu" />}
              >
                <EllipsisIcon />
              </MenuTrigger>
            </TooltipTrigger>
            <TooltipPopup>Thread menu</TooltipPopup>
          </Tooltip>
          <MenuPopup
            side="top"
            align="end"
            className="w-[min(18rem,calc(100vw-2rem))]"
            finalFocus={!focusHandedOff}
            {...composerFloatingLayerProps}
          >
            {inMenuItems.map((item) => (
              <Fragment key={item.id}>{menuRow(item)}</Fragment>
            ))}
            {inMenuItems.length > 0 && menuOnlyItems.length > 0 ? <MenuSeparator /> : null}
            {menuOnlyItems.map((item) => (
              <Fragment key={item.id}>{menuRow(item)}</Fragment>
            ))}
          </MenuPopup>
        </Menu>
        <Popover
          open={popoverItem !== undefined}
          onOpenChange={(open) => {
            if (!open) setPopoverItemId(null);
          }}
        >
          {popoverItem ? (
            <PopoverPopup
              aria-label={popoverItem.label}
              anchor={menuButton}
              finalFocus={() => menuButton}
              side="top"
              align="end"
              padding="none"
              width={popoverItem.width ?? "md"}
              {...composerFloatingLayerProps}
            >
              {popoverItem.render(() => setPopoverItemId(null))}
            </PopoverPopup>
          ) : null}
        </Popover>
      </div>
    </ComposerSurface.ContextStrip>
  );
}
