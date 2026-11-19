import { LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  ARRIVAL_LABELS,
  LINK_LEVEL_CHOICES,
  REACH_LEVEL_LABELS,
  type ReachLevel,
  type ReachSquare,
  type SquareState,
  squareKey,
} from "./reachModel.logic";
import type { SquareChangeState } from "./useSquareChange";

const LEVEL_TONE: Record<ReachLevel, string> = {
  "full-access": "text-success",
  auto: "text-success",
  "auto-accept-edits": "text-warning",
  "approval-required": "text-warning",
  "can-change": "text-warning",
  custom: "text-warning",
  "read-only": "text-info",
};

const LEVEL_GLYPH: Record<ReachLevel, string> = {
  "full-access": "●",
  auto: "●",
  "auto-accept-edits": "◐",
  "approval-required": "◐",
  "can-change": "◐",
  custom: "◐",
  "read-only": "○",
};

/** One square's state as a glyph, with its words for screen readers. */
export function SquareGlyph({ state }: { readonly state: SquareState }) {
  switch (state.kind) {
    case "self":
      return <span className="text-2xs">itself</span>;
    case "none":
      return <span aria-label="No access">–</span>;
    case "no-path":
      return <span className="text-2xs">no path</span>;
    case "unknown":
      return <span aria-label="Unknown">?</span>;
    case "level":
      return (
        <span
          className={cn(LEVEL_TONE[state.level], state.broken !== null && "opacity-50")}
          aria-label={`${REACH_LEVEL_LABELS[state.level]}${state.broken ? `, ${state.broken}` : ""}`}
        >
          {LEVEL_GLYPH[state.level]}
          {state.broken !== null ? <span className="text-destructive">!</span> : null}
        </span>
      );
  }
}

export const GRID_LEGEND: ReadonlyArray<{
  readonly glyph: ReactNode;
  readonly label: string;
  readonly tone: string;
}> = [
  { glyph: "●", label: "Full access", tone: "text-success" },
  { glyph: "◐", label: "Ask before changes", tone: "text-warning" },
  { glyph: "○", label: "View only", tone: "text-info" },
  { glyph: "–", label: "No access", tone: "text-muted-foreground" },
  { glyph: "no path", label: "Nothing can reach it", tone: "text-muted-foreground" },
  { glyph: "?", label: "Unknown here", tone: "text-muted-foreground" },
  { glyph: "!", label: "Expired or refused", tone: "text-destructive" },
  {
    glyph: <LockIcon className="inline size-3" />,
    label: "Set on that machine",
    tone: "text-muted-foreground",
  },
];

/**
 * "From X to Y: level", the sentence every square and line is read as. An uncertain line says so
 * instead of repeating a level that may no longer hold.
 */
export function squareSentence(square: ReachSquare, uncertain = false): string {
  const { state } = square;
  if (state.kind === "self") return `${square.from.label} itself`;
  const level = uncertain
    ? "Uncertain"
    : state.kind === "level"
      ? `${REACH_LEVEL_LABELS[state.level]}${state.broken === "expired" ? " (expired)" : state.broken === "unauthorized" ? ` (refused by ${square.to.label})` : ""}`
      : state.kind === "none"
        ? "No access"
        : state.kind === "no-path"
          ? "No path"
          : state.kind === "unknown"
            ? "Unknown"
            : "itself";
  return `From ${square.from.label} to ${square.to.label}: ${level}`;
}

export function ArrivalTag({ square }: { readonly square: ReachSquare }) {
  const arrival = square.arrivedVia;
  if (arrival === null) return null;
  const tag = (
    <span className="rounded-sm border border-border px-1 text-2xs whitespace-nowrap text-muted-foreground">
      {ARRIVAL_LABELS[arrival]}
    </span>
  );
  return square.arrivedFrom === null ? (
    tag
  ) : (
    <Tooltip>
      <TooltipTrigger render={tag} />
      <TooltipPopup side="top">{square.arrivedFrom}</TooltipPopup>
    </Tooltip>
  );
}

/** The confirm strip, progress or failure of a change to one square, where it was clicked. */
export function SquareChangeStatus({
  change,
  square,
}: {
  readonly change: SquareChangeState;
  readonly square: ReachSquare;
}) {
  const key = squareKey(square.from.id, square.to.id);
  if (change.pending?.key === key) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" role="status">
        <span className="basis-full text-warning-foreground">{change.pending.plan.sentence}</span>
        <Button size="xs" variant="default" onClick={change.confirm} autoFocus>
          Confirm
        </Button>
        <Button size="xs" variant="outline" onClick={change.cancel}>
          Cancel
        </Button>
      </div>
    );
  }
  if (change.busyKey === key) {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground" role="status">
        Working…
      </p>
    );
  }
  const error = change.errors.get(key);
  if (!error) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" role="alert">
      <span className="basis-full text-destructive">{error}</span>
      {change.uncertain.has(key) ? (
        <Button size="xs" variant="default" onClick={() => change.linkAgain(key)}>
          Link again
        </Button>
      ) : null}
    </div>
  );
}

/** The level buttons for one square, in a fixed order so nothing moves after a click. */
export function LevelChoices({
  change,
  square,
}: {
  readonly change: SquareChangeState;
  readonly square: ReachSquare;
}) {
  const uncertain = change.uncertain.has(squareKey(square.from.id, square.to.id));
  // undefined presses nothing, so an uncertain line does not look like it kept a level.
  const current = uncertain ? undefined : square.state.kind === "level" ? square.state.level : null;
  const busy = change.busyKey !== null;
  const { changes } = square;
  return (
    <div className="flex flex-wrap gap-1.5">
      {LINK_LEVEL_CHOICES.map((level) => (
        <Button
          key={level}
          size="xs"
          variant={current === level ? "secondary" : "outline"}
          aria-pressed={current === level}
          disabled={busy || !changes.canRelink}
          onClick={() => change.request(square, level)}
        >
          {REACH_LEVEL_LABELS[level]}
        </Button>
      ))}
      <Button
        size="xs"
        variant={current === null ? "secondary" : "outline"}
        aria-pressed={current === null}
        disabled={busy || !changes.canRemove}
        onClick={() => change.request(square, "none")}
      >
        No access
      </Button>
    </div>
  );
}
