/** The product name people see in the app's own text. */
export const APP_BASE_NAME = "Weavewing";

export type MobileStageLabel = "Beta" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Beta";
}
