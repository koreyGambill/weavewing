import type { ViewDefinition, ViewLayout } from "./viewRegistry";

export type ViewPageResolution =
  | { readonly kind: "page"; readonly definition: ViewDefinition }
  /** The view has a route of its own, which the shared page hands over to. */
  | { readonly kind: "own-route"; readonly definition: ViewDefinition }
  | { readonly kind: "thread-view"; readonly definition: ViewDefinition }
  | { readonly kind: "unknown" };

/** What the shared view page shows for a route's view id. */
export function resolveViewPage(
  viewId: string,
  definitions: ReadonlyArray<ViewDefinition>,
): ViewPageResolution {
  const definition = definitions.find((entry) => entry.id === viewId);
  if (!definition) return { kind: "unknown" };
  if (definition.scope === "thread") return { kind: "thread-view", definition };
  if (definition.page === "/view/$viewId") return { kind: "page", definition };
  return definition.page ? { kind: "own-route", definition } : { kind: "unknown" };
}

/**
 * The layout a host gives a view at its width. A host narrower than the view's `minWidthPx`
 * renders it compact and, when the view has a page, offers to open it full size.
 */
export function resolveHostedViewLayout(
  definition: Pick<ViewDefinition, "minWidthPx" | "page">,
  host: { readonly layout: ViewLayout; readonly width: number },
): { readonly layout: ViewLayout; readonly openFullSize: boolean } {
  const cramped = host.width < definition.minWidthPx;
  return {
    layout: cramped ? "compact" : host.layout,
    openFullSize: cramped && definition.page !== undefined,
  };
}

/** Global views the command palette offers to open as a page. */
export function viewPagePaletteDefinitions(
  definitions: ReadonlyArray<ViewDefinition>,
): ReadonlyArray<ViewDefinition> {
  // Pull requests keeps its own "Open pull requests" entry.
  return definitions.filter((entry) => entry.scope === "global" && entry.page === "/view/$viewId");
}
