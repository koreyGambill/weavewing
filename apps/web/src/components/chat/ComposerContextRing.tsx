import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl } from "./ComposerControl";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { contextBreakdown } from "./contextBreakdown.logic";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** How full the context window is, with the breakdown and Compact one click away. Static: no animation. */
export function ComposerContextRing({
  usage,
  compactDisabled,
  onCompact,
}: {
  readonly usage: ContextWindowSnapshot | null;
  readonly compactDisabled: boolean;
  readonly onCompact: () => void;
}) {
  // A draft with nothing reported yet shows nothing rather than an empty meter.
  if (usage === null) return null;
  const breakdown = contextBreakdown(usage);
  const percent = breakdown.usedPercent ?? 0;
  const tone =
    breakdown.tone === "critical"
      ? "text-destructive"
      : breakdown.tone === "warning"
        ? "text-warning"
        : "text-foreground";
  const amount =
    breakdown.maxTokens === null
      ? formatContextWindowTokens(breakdown.usedTokens)
      : `${formatContextWindowTokens(breakdown.usedTokens)} / ${formatContextWindowTokens(breakdown.maxTokens)}`;
  const label =
    breakdown.usedPercent === null
      ? `Context: ${formatContextWindowTokens(breakdown.usedTokens)} tokens used`
      : `Context: ${amount}, ${Math.round(breakdown.usedPercent)}% used`;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ComposerControl
            size="xs"
            className="gap-1.5"
            aria-label={label}
            data-composer-context-ring=""
          />
        }
      >
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            className="stroke-border"
          />
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2"
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={`${(percent / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
            transform="rotate(-90 8 8)"
            className={tone}
          />
        </svg>
        <span
          className={cn(
            "hidden tabular-nums @lg/composer-surface:inline",
            breakdown.tone !== "normal" && tone,
          )}
        >
          {amount}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="sm">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">Context</span>
          <span className="text-muted-foreground tabular-nums">{amount}</span>
        </div>
        {breakdown.usedPercent !== null ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className={cn("h-full bg-current", tone)}
              style={{ width: `${Math.min(100, breakdown.usedPercent)}%` }}
            />
          </div>
        ) : null}
        <dl className="mt-2 grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-xs">
          {breakdown.rows.map((row) => (
            <BreakdownRow
              key={row.label}
              label={row.label}
              tokens={row.tokens}
              percent={row.percent}
            />
          ))}
        </dl>
        {breakdown.kinds.length > 0 ? (
          <>
            <p className="mt-3 text-muted-foreground text-xs">Latest report from the provider</p>
            <dl className="mt-1 grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-xs">
              {breakdown.kinds.map((kind) => (
                <BreakdownRow
                  key={kind.label}
                  label={kind.label}
                  tokens={kind.tokens}
                  percent={null}
                />
              ))}
            </dl>
          </>
        ) : null}
        <div className="mt-3 flex items-center gap-2 border-t pt-2">
          <PopoverClose
            render={<Button size="xs" variant="outline" />}
            disabled={compactDisabled}
            onClick={onCompact}
          >
            Compact
          </PopoverClose>
          <span className="min-w-0 text-muted-foreground text-xs">
            {formatContextWindowCompactionMessage(usage.autoCompactThreshold)}
          </span>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function BreakdownRow({
  label,
  tokens,
  percent,
}: {
  readonly label: string;
  readonly tokens: number;
  readonly percent: number | null;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="text-right text-muted-foreground tabular-nums">
        {formatContextWindowTokens(tokens)}
      </dd>
      <dd className="w-10 text-right tabular-nums">{percent === null ? "" : `${percent}%`}</dd>
    </>
  );
}
