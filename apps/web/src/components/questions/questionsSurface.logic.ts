import type { RightPanelSurface } from "../../rightPanelStore";

/**
 * Questions tabs to close once the environment's settings say agent questions are off. Unknown
 * settings (`null`, still loading) close nothing, so a restored tab survives startup.
 */
export function questionSurfaceIdsToClose(
  surfaces: ReadonlyArray<Pick<RightPanelSurface, "id" | "kind">>,
  agentQuestionsEnabled: boolean | null,
): ReadonlyArray<string> {
  if (agentQuestionsEnabled !== false) return [];
  return surfaces.flatMap((surface) => (surface.kind === "questions" ? [surface.id] : []));
}
