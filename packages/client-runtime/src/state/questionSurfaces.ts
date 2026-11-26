/**
 * Questions tabs to close once the environment's settings say agent questions are off. Unknown
 * settings (`null`, still loading) close nothing, so a restored tab survives startup.
 */
export function questionSurfaceIdsToClose(
  surfaces: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
  waitingCardsEnabled: boolean | null,
): ReadonlyArray<string> {
  if (waitingCardsEnabled !== false) return [];
  return surfaces.flatMap((surface) => (surface.kind === "questions" ? [surface.id] : []));
}
