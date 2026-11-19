import { LockIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createStore, type StoreApi, useStore } from "zustand";

import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup } from "../../ui/popover";
import { SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import {
  GRID_LEGEND,
  LevelChoices,
  SquareChangeStatus,
  SquareGlyph,
  squareSentence,
} from "./LevelControls";
import { type ReachModel, type ReachParty, type ReachSquare, squareKey } from "./reachModel.logic";
import type { SquareChangeState } from "./useSquareChange";

type Focus =
  | { readonly kind: "square"; readonly from: string; readonly to: string }
  | { readonly kind: "row"; readonly id: string }
  | { readonly kind: "column"; readonly id: string };

interface Popup {
  readonly focus: Focus;
  readonly anchor: HTMLElement;
  /** A click pins it and offers the levels; pointing or focusing only previews. */
  readonly pinned: boolean;
}

interface PopupState {
  readonly popup: Popup | null;
  readonly show: (focus: Focus, anchor: HTMLElement, pinned: boolean) => void;
  readonly hidePreview: () => void;
  readonly close: () => void;
}

type PopupStore = StoreApi<PopupState>;

const focusKey = (focus: Focus) =>
  focus.kind === "square" ? `square:${focus.from}>${focus.to}` : `${focus.kind}:${focus.id}`;

// Pointing at squares changes only this store, so a hover re-renders the squares it lights
// and the popup, not the whole grid.
function createPopupStore(): PopupStore {
  return createStore<PopupState>((set, get) => ({
    popup: null,
    show: (focus, anchor, pinned) => {
      const current = get().popup;
      if (!pinned && current?.pinned) return;
      if (!pinned && current !== null && focusKey(current.focus) === focusKey(focus)) return;
      set({ popup: { focus, anchor, pinned } });
    },
    hidePreview: () => {
      if (get().popup?.pinned === false) set({ popup: null });
    },
    close: () => set({ popup: null }),
  }));
}

function isHot(popup: Popup | null, from: string, to: string): boolean {
  const focus = popup?.focus;
  if (focus === undefined) return false;
  switch (focus.kind) {
    case "square":
      return (focus.from === from && focus.to === to) || (focus.from === to && focus.to === from);
    case "row":
      return focus.id === from;
    case "column":
      return focus.id === to;
  }
}

const KEY_STEPS: Record<string, readonly [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

/**
 * Who can reach what: rows are "From", columns "To", one square per direction. Pointing at a
 * square shows both directions; clicking pins them and offers the levels. A level only ever
 * changes from the popup's buttons, never from the square.
 */
export function ReachGrid({
  model,
  change,
}: {
  readonly model: ReachModel;
  readonly change: SquareChangeState;
}) {
  const [store] = useState(createPopupStore);
  const [active, setActive] = useState({ row: 0, column: 0 });
  const cells = useRef(new Map<string, HTMLButtonElement>());
  const { rows, columns } = model;
  if (columns.length === 0) return null;
  const activeRow = Math.min(active.row, rows.length - 1);
  const activeColumn = Math.min(active.column, columns.length - 1);

  const onGridKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const step = KEY_STEPS[event.key];
    if (step === undefined || !(event.target instanceof HTMLButtonElement)) return;
    if (!cells.current.has(event.target.dataset.square ?? "")) return;
    event.preventDefault();
    const row = Math.max(0, Math.min(rows.length - 1, activeRow + step[0]));
    const column = Math.max(0, Math.min(columns.length - 1, activeColumn + step[1]));
    setActive({ row, column });
    cells.current.get(squareKey(rows[row]!.id, columns[column]!.id))?.focus();
  };

  return (
    <SettingsSection {...searchableSetting("linked-environments")} title="Who can reach what">
      <div className="px-3 py-3 sm:px-4" onPointerLeave={() => store.getState().hidePreview()}>
        <div className="overflow-x-auto">
          <table
            className="w-full table-fixed border-collapse text-xs"
            style={{ minWidth: `${9 + columns.length * 5}rem` }}
            onKeyDown={onGridKeyDown}
          >
            <thead>
              <tr>
                <th className="w-[31%] border border-border" />
                {columns.map((column) => (
                  <th key={column.id} className="border border-border p-0 font-normal">
                    <HeaderButton
                      store={store}
                      party={column}
                      focus={{ kind: "column", id: column.id }}
                      locked={!model.manageable.has(column.id)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={row.id} className={cn(row.kind === "app" && "[&>*]:border-t-2")}>
                  <th scope="row" className="border border-border p-0 text-left font-normal">
                    <HeaderButton
                      store={store}
                      party={row}
                      focus={{ kind: "row", id: row.id }}
                      locked={false}
                    />
                  </th>
                  {columns.map((column, columnIndex) => {
                    const square = model.squares.get(squareKey(row.id, column.id));
                    return (
                      <td key={column.id} className="border border-border p-0">
                        {square ? (
                          <SquareCell
                            store={store}
                            square={square}
                            uncertain={change.uncertain.has(squareKey(row.id, column.id))}
                            cells={cells}
                            tabbable={rowIndex === activeRow && columnIndex === activeColumn}
                            onActivate={() => setActive({ row: rowIndex, column: columnIndex })}
                          />
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {GRID_LEGEND.map((entry) => (
            <li key={entry.label}>
              <span aria-hidden className={entry.tone}>
                {entry.glyph}
              </span>{" "}
              {entry.label}
            </li>
          ))}
        </ul>
      </div>
      <GridPopup store={store} model={model} change={change} />
    </SettingsSection>
  );
}

function GridPopup({
  store,
  model,
  change,
}: {
  readonly store: PopupStore;
  readonly model: ReachModel;
  readonly change: SquareChangeState;
}) {
  const popup = useStore(store, (state) => state.popup);
  return (
    <Popover
      open={popup !== null}
      onOpenChange={(open) => {
        if (!open) store.getState().close();
      }}
    >
      {popup !== null ? (
        <PopoverPopup
          anchor={popup.anchor}
          side="bottom"
          align="start"
          width="md"
          padding="compact"
          initialFocus={popup.pinned}
          finalFocus={popup.pinned ? { current: popup.anchor } : false}
        >
          <PopupBody model={model} popup={popup} change={change} />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}

function HeaderButton({
  store,
  party,
  focus,
  locked,
}: {
  readonly store: PopupStore;
  readonly party: ReachParty;
  readonly focus: Extract<Focus, { readonly kind: "row" | "column" }>;
  readonly locked: boolean;
}) {
  const hot = useStore(
    store,
    (state) => state.popup?.focus.kind === focus.kind && state.popup.focus.id === focus.id,
  );
  return (
    <button
      type="button"
      aria-label={`${focus.kind === "column" ? "To" : "From"} ${party.label}`}
      className={cn(
        "flex w-full min-w-0 items-center gap-1 px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        focus.kind === "column" ? "justify-center" : "justify-start",
        hot && "bg-primary/15",
      )}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") store.getState().show(focus, event.currentTarget, false);
      }}
      onClick={(event) => store.getState().show(focus, event.currentTarget, true)}
    >
      <span className="text-2xs tracking-wide text-muted-foreground uppercase">
        {focus.kind === "column" ? "To" : "From"}
      </span>
      <PartyName label={party.label} />
      {locked ? (
        <LockIcon role="img" aria-label="Set on that machine" className="size-3 shrink-0" />
      ) : null}
    </button>
  );
}

/**
 * Names that share a long start, such as two servers on one machine, differ in their last
 * " · " part, so that part stays whole and the start gives way.
 */
function PartyName({ label }: { readonly label: string }) {
  const split = label.lastIndexOf(" · ");
  if (split === -1) return <span className="min-w-0 truncate">{label}</span>;
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate">{label.slice(0, split)}</span>
      <span className="shrink-0 text-muted-foreground">{label.slice(split)}</span>
    </span>
  );
}

function SquareCell({
  store,
  square,
  uncertain,
  cells,
  tabbable,
  onActivate,
}: {
  readonly store: PopupStore;
  readonly square: ReachSquare;
  /** A relink failed after the target may have changed, so the level shown may be wrong. */
  readonly uncertain: boolean;
  readonly cells: RefObject<Map<string, HTMLButtonElement>>;
  readonly tabbable: boolean;
  readonly onActivate: () => void;
}) {
  const from = square.from.id;
  const to = square.to.id;
  const key = squareKey(from, to);
  const hot = useStore(store, (state) => isHot(state.popup, from, to));
  const { state } = square;
  const focus: Focus = { kind: "square", from, to };
  const self = state.kind === "self";
  return (
    <button
      ref={(element) => {
        if (element) cells.current.set(key, element);
        else cells.current.delete(key);
      }}
      type="button"
      data-square={key}
      tabIndex={tabbable ? 0 : -1}
      aria-label={uncertain ? `${squareSentence(square)}, uncertain` : squareSentence(square)}
      className={cn(
        "block w-full py-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        state.kind === "no-path" && "bg-muted/60 text-muted-foreground",
        self && "bg-muted text-2xs text-muted-foreground",
        (state.kind === "unknown" || state.kind === "none") && "text-muted-foreground",
        hot && "bg-primary/15",
      )}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse" && !self) {
          store.getState().show(focus, event.currentTarget, false);
        }
      }}
      onFocus={(event) => {
        onActivate();
        // A server's own square only holds a place for the arrow keys.
        if (self) store.getState().hidePreview();
        else store.getState().show(focus, event.currentTarget, false);
      }}
      onClick={(event) => {
        if (!self) store.getState().show(focus, event.currentTarget, true);
      }}
    >
      <SquareGlyph state={uncertain ? { kind: "unknown", reason: "" } : state} />
    </button>
  );
}

function PopupBody({
  model,
  popup,
  change,
}: {
  readonly model: ReachModel;
  readonly popup: Popup;
  readonly change: SquareChangeState;
}) {
  const { focus } = popup;
  if (focus.kind !== "square") {
    const squares =
      focus.kind === "row"
        ? model.columns.map((column) => model.squares.get(squareKey(focus.id, column.id)))
        : model.rows.map((row) => model.squares.get(squareKey(row.id, focus.id)));
    const lines = squares.filter(
      (square): square is ReachSquare => square !== undefined && square.state.kind !== "self",
    );
    const party =
      focus.kind === "row"
        ? model.rows.find((row) => row.id === focus.id)
        : model.columns.find((column) => column.id === focus.id);
    return (
      <ul className="space-y-0.5 text-xs leading-relaxed">
        {party ? <li className="font-medium">{party.label}</li> : null}
        {lines.map((square) => (
          <li key={squareKey(square.from.id, square.to.id)}>{squareSentence(square)}</li>
        ))}
      </ul>
    );
  }
  const square = model.squares.get(squareKey(focus.from, focus.to));
  if (square === undefined) return null;
  const reverse = model.squares.get(squareKey(focus.to, focus.from));
  const { state, changes } = square;
  return (
    <div className="space-y-2 text-xs leading-relaxed">
      <div>
        <p>{squareSentence(square)}</p>
        <p className="text-muted-foreground">
          {reverse ? squareSentence(reverse) : `Nothing connects in to ${square.from.label}`}
        </p>
      </div>
      {state.kind === "unknown" ? <p className="text-muted-foreground">{state.reason}</p> : null}
      {popup.pinned ? <PinnedControls square={square} change={change} /> : null}
      {popup.pinned &&
      square.from.kind === "server" &&
      state.kind !== "no-path" &&
      state.kind !== "unknown" &&
      changes.lockedReason === null ? (
        <p className="text-muted-foreground">Lowering applies at once. Raising asks first.</p>
      ) : null}
    </div>
  );
}

function PinnedControls({
  square,
  change,
}: {
  readonly square: ReachSquare;
  readonly change: SquareChangeState;
}) {
  const { state, changes } = square;
  if (state.kind === "no-path") {
    return (
      <p className="text-muted-foreground">
        No path yet. {square.to.label} has no address that {square.from.label} can reach.
      </p>
    );
  }
  if (state.kind === "unknown") return null;
  // A device or this app keeps the level it paired with, so removing it is all there is to do.
  if (square.from.kind !== "server" && changes.lockedReason === null) {
    return (
      <>
        {changes.canRemove ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={change.busyKey !== null}
            onClick={() => change.request(square, "none")}
          >
            Remove access
          </Button>
        ) : null}
        <SquareChangeStatus change={change} square={square} />
      </>
    );
  }
  if (changes.lockedReason !== null) {
    return (
      <>
        <p className="text-muted-foreground">
          <LockIcon aria-hidden className="mr-1 inline size-3" />
          {square.to.label} decides this. This app does not have full access to it.
        </p>
        {changes.canRemove ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={change.busyKey !== null}
            onClick={() => change.request(square, "none")}
          >
            Give up…
          </Button>
        ) : null}
        <SquareChangeStatus change={change} square={square} />
      </>
    );
  }
  return (
    <>
      <LevelChoices change={change} square={square} />
      {!changes.canRelink && changes.relinkBlockedReason ? (
        <p className="text-muted-foreground">{changes.relinkBlockedReason}</p>
      ) : null}
      <SquareChangeStatus change={change} square={square} />
    </>
  );
}
