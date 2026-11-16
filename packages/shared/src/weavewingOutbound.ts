/**
 * Weavewing outbound policy: the app never contacts a third party on its own, while
 * user actions (links, connectors, gh, providers, the browser panel) keep working.
 * Guarded by apps/web/src/weavewingOutbound.test.ts.
 */

/** The host a rendered URL would contact, or null for data:, blob: and other local sources. */
export function remoteMediaHost(uri: string): string | null {
  try {
    const url = new URL(uri.startsWith("//") ? `https:${uri}` : uri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * Fetch directives for agent HTML (html_render pages, previewed .html files). Inline
 * script, style and data: or blob: media work; subresources cannot leave the page.
 * CSP cannot stop the page navigating itself: see agentHtmlNavigationBlocked.
 */
export const OFFLINE_HTML_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; font-src 'self' data:; " +
  "media-src 'self' data: blob:; worker-src blob:; form-action 'none'";

/** No popups or top navigation; links go through the html_render link bridge. */
export const AGENT_HTML_SANDBOX = "allow-scripts allow-forms allow-downloads";

const ASSET_ROUTE = "/api/assets/";

/**
 * Whether an asset-route page (agent HTML) may not navigate its frame to `target`.
 * Only the desktop shell can enforce this; a web browser lets a scripted frame
 * navigate itself, so on web agent HTML can still send one request by navigating.
 */
export function agentHtmlNavigationBlocked(frameUrl: string, target: string): boolean {
  let frame: URL;
  try {
    frame = new URL(frameUrl);
  } catch {
    return false;
  }
  if (!frame.pathname.startsWith(ASSET_ROUTE) || target === "about:blank") return false;
  try {
    const url = new URL(target);
    return url.origin !== frame.origin || !url.pathname.startsWith(ASSET_ROUTE);
  } catch {
    return true;
  }
}

/** Build-time telemetry exporters a Weavewing build never bakes in; runtime env still enables them. */
export const UNBAKED_TELEMETRY_ENV_KEYS = [
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
  "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
  "VITE_RELAY_OTLP_TRACES_URL",
  "VITE_RELAY_OTLP_TRACES_DATASET",
  "VITE_RELAY_OTLP_TRACES_TOKEN",
  "T3CODE_MOBILE_OTLP_TRACES_URL",
  "T3CODE_MOBILE_OTLP_TRACES_DATASET",
  "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
  "EXPO_PUBLIC_OTLP_TRACES_URL",
  "EXPO_PUBLIC_OTLP_TRACES_DATASET",
  "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
] as const;
