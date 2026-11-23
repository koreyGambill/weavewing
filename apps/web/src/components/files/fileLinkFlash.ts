/** How long linked lines stay tinted: a hold, then a fade. */
const FILE_LINK_REVEAL_FLASH_MS = 1400;

const FLASH_ANIMATION_ID = "file-link-reveal-flash";

const FLASH_KEYFRAMES: Keyframe[] = [
  { "--file-link-reveal-strength": 1, offset: 0 },
  { "--file-link-reveal-strength": 1, offset: 0.7 },
  { "--file-link-reveal-strength": 0, offset: 1 },
];

export function fileLinkFlashNow(): number {
  return Number(document.timeline.currentTime ?? performance.now());
}

/**
 * Fades `--file-link-reveal-strength` on `target`, which its tinted rows inherit. The animation
 * is pinned to `startedAt` on the document timeline: a script animation keeps running while its
 * tile is `display: none`, and calling this again for the same flash keeps it rather than
 * restarting. With reduced motion the rows hold a static tint instead.
 */
export function playFileLinkFlash(target: Element, startedAt: number): void {
  const existing = target.getAnimations().find((animation) => animation.id === FLASH_ANIMATION_ID);
  if (existing?.startTime === startedAt) return;
  existing?.cancel();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const animation = target.animate(FLASH_KEYFRAMES, {
    duration: FILE_LINK_REVEAL_FLASH_MS,
    easing: "ease-out",
  });
  animation.id = FLASH_ANIMATION_ID;
  animation.startTime = startedAt;
}

export function stopFileLinkFlash(target: Element): void {
  for (const animation of target.getAnimations()) {
    if (animation.id === FLASH_ANIMATION_ID) animation.cancel();
  }
}

/** Milliseconds of a flash started at `startedAt` that are still to run. */
export function remainingFileLinkFlashMs(startedAt: number, now: number): number {
  return Math.max(0, startedAt + FILE_LINK_REVEAL_FLASH_MS - now);
}
