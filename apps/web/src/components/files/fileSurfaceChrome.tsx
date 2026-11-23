import type { ReactNode } from "react";

import { Spinner } from "~/components/ui/spinner";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

export const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-7 min-h-7 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-1 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent";

export const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";

export const FILE_LINK_REVEAL_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}

  diffs-container {
    --diffs-bg: var(--code-background, var(--background)) !important;
    --diffs-light-bg: var(--code-background, var(--background)) !important;
    --diffs-dark-bg: var(--code-background, var(--background)) !important;
    background-color: var(--code-background, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }

  /* Rows inherit --file-link-reveal-strength from the container, which playFileLinkFlash
     animates. It is registered in index.css; a registration in this shadow root is ignored. */
  @media (prefers-reduced-motion: reduce) {
    [${FILE_LINK_REVEAL_ATTRIBUTE}] {
      --file-link-reveal-strength: 1;
    }
  }

  /* Tint through --diffs-line-bg, not background-color. The editor paints row
     tints on a layer below its text selection; a background on the row itself
     covers the selection and makes selected text on this line invisible. */
  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    --diffs-line-bg: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) calc(100% - 18% * var(--file-link-reveal-strength)),
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) calc(100% - 25% * var(--file-link-reveal-strength)),
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) calc(100% - 25% * var(--file-link-reveal-strength)),
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) calc(100% - 40% * var(--file-link-reveal-strength)),
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
  }
`;

export function FileSurfaceAction(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** Keeps the action visible and hoverable, with the reason as its tooltip. */
  readonly disabledReason?: string | null;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const pressed = props.pressed;
  const reason = props.disabledReason ?? null;
  const onPress = () => {
    if (reason === null) props.onPress();
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          pressed === undefined ? (
            <Button
              type="button"
              className="shrink-0"
              disabled={props.disabled ?? false}
              aria-disabled={reason !== null || undefined}
              onClick={onPress}
              aria-label={props.label}
              variant="ghost"
              size="icon-micro"
            >
              {props.children}
            </Button>
          ) : (
            <Toggle
              className="shrink-0"
              pressed={pressed}
              disabled={props.disabled ?? false}
              aria-disabled={reason !== null || undefined}
              onPressedChange={onPress}
              aria-label={props.label}
              variant="ghost"
              size="micro"
            >
              {props.children}
            </Toggle>
          )
        }
      />
      <TooltipPopup>{reason === null ? props.label : `${props.label}: ${reason}`}</TooltipPopup>
    </Tooltip>
  );
}

export function FileSurfaceNotice(props: { readonly children: ReactNode }) {
  return (
    <div
      role="status"
      className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground"
    >
      {props.children}
    </div>
  );
}

export function FileSurfaceLoading(props: { readonly className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading file"
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center text-muted-foreground",
        props.className,
      )}
    >
      <Spinner size="lg" />
    </div>
  );
}

export function FileSurfaceFailure(props: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed"
    >
      <p className="text-destructive">{props.message}</p>
      {props.onRetry ? (
        <button
          type="button"
          onClick={props.onRetry}
          className="rounded-md border border-input px-2.5 py-1 text-xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
