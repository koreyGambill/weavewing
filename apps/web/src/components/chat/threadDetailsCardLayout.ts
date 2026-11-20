import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";

export const THREAD_DETAILS_CARD_GAP = 12;
// Keep in sync with --thread-details-panel-width.
const THREAD_DETAILS_CARD_WIDTH = 280;

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

export function resolveThreadDetailsCardLayout({
  container,
  frame,
  overlapsDetailsCard = false,
  topInset = 0,
  bottomInset = 0,
}: {
  container: { width: number; height: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  topInset?: number;
  bottomInset?: number;
}) {
  const gap = THREAD_DETAILS_CARD_GAP;
  const preferredWidth = Math.max(208, Math.floor(container.width * 0.75));
  const width = Math.min(THREAD_DETAILS_CARD_WIDTH, preferredWidth, container.width - gap * 2);
  if (width <= 0) return null;
  const x = container.width - width - gap;
  const y = gap + topInset;
  const availableHeight = container.height - y - gap;
  const maxHeight = availableHeight - Math.min(bottomInset, Math.max(0, availableHeight - 160));
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x - gap && frame.x < x + width + gap
      ? Math.min(maxHeight, frame.y - y - gap)
      : maxHeight;
  if (height < 160) return null;
  return {
    x,
    right: gap,
    width,
    y,
    height,
  } as const;
}
