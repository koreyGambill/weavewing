import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A card button with its hint on hover and focus; the hint stays reachable while disabled. */
export function HelpButton({
  help,
  children,
  variant = "contrast-outline",
  ...props
}: {
  readonly help: string;
  readonly children: ReactNode;
} & Pick<
  Parameters<typeof Button>[0],
  "disabled" | "onClick" | "variant" | "aria-pressed" | "aria-label" | "ref"
>) {
  return (
    <Tooltip>
      {/* A span keeps the hint reachable while the button is disabled. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button size="xs" variant={variant} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {help}
      </TooltipPopup>
    </Tooltip>
  );
}

const headingButtonClass =
  "flex min-w-0 flex-1 cursor-pointer rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * A settled card's one line: its ref, title and outcome, which expands to the read-only card,
 * followed by `controls` such as the status badge and Reopen.
 */
export function ThreadCardClosedLine({
  id,
  label,
  refLabel,
  title,
  outcome,
  hint,
  expandRef,
  onExpand,
  stackOnNarrow = false,
  children,
}: {
  readonly id: string | undefined;
  /** The section's accessible name, such as "Q3: Which backoff?". */
  readonly label: string;
  readonly refLabel: string;
  readonly title: string;
  readonly outcome: string | null;
  /** More for the line's tooltip, such as why it was dismissed. */
  readonly hint?: ReactNode;
  readonly expandRef?: Ref<HTMLButtonElement>;
  readonly onExpand: () => void;
  /** On a narrow card, `children` move under the title so the title stays readable. */
  readonly stackOnNarrow?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className="@container min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5"
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 text-sm",
          stackOnNarrow && "flex-wrap justify-end @min-[28rem]:flex-nowrap",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={expandRef}
                type="button"
                aria-expanded={false}
                onClick={onExpand}
                className={cn(
                  headingButtonClass,
                  "items-baseline gap-2",
                  stackOnNarrow && "basis-full @min-[28rem]:basis-auto",
                )}
              />
            }
          >
            <span className="shrink-0 font-semibold tabular-nums text-muted-foreground">
              {refLabel}
            </span>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {outcome ? (
              <span className="max-w-[45%] shrink-0 truncate font-semibold">{outcome}</span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-96">
            <p>{title}</p>
            {outcome ? <p className="font-semibold">{outcome}</p> : null}
            {hint}
          </TooltipPopup>
        </Tooltip>
        {children}
      </div>
    </section>
  );
}

/** The card's ref and title, in the primary color while the user can still act on it. */
export function ThreadCardHeading({
  refLabel,
  title,
  editable,
}: {
  readonly refLabel: string;
  readonly title: string;
  readonly editable: boolean;
}) {
  return (
    <>
      <span
        className={cn(
          "shrink-0 text-sm font-semibold tabular-nums",
          editable ? "text-primary" : "text-muted-foreground",
        )}
      >
        {refLabel}
      </span>
      <h3 className="min-w-0 flex-1 text-sm font-medium leading-snug break-words">{title}</h3>
    </>
  );
}

/**
 * An agent item waiting on the user, or an expanded settled one: a left edge in the primary color
 * while it waits, a header whose heading collapses a settled card, and the kind's body.
 */
export function ThreadCard({
  id,
  label,
  waiting,
  heading,
  onCollapse,
  controls,
  children,
}: {
  readonly id: string | undefined;
  readonly label: string;
  readonly waiting: boolean;
  readonly heading: ReactNode;
  /** Set on an expanded settled card: the heading collapses it back to its line. */
  readonly onCollapse?: (() => void) | undefined;
  /** The header's right side, such as the status badge. */
  readonly controls?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className={cn(
        "@container min-w-0 space-y-1.5 rounded-lg border border-border border-l-2 bg-background px-2.5 py-2",
        waiting ? "border-l-primary" : "border-l-border",
      )}
    >
      <header className="flex min-w-0 items-start gap-2">
        {onCollapse ? (
          <button
            type="button"
            aria-expanded
            onClick={onCollapse}
            className={cn(headingButtonClass, "items-start gap-2")}
          >
            {heading}
          </button>
        ) : (
          heading
        )}
        {controls}
      </header>
      {children}
    </section>
  );
}
