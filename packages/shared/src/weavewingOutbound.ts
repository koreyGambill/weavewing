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
 * Fetch directives for agent HTML (html_render pages, previewed .html files).
 * Inline script, style and data: or blob: media keep working; nothing leaves the
 * page. 'self' is the T3 server serving the page, never a third party.
 */
export const OFFLINE_HTML_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "style-src 'self' 'unsafe-inline' data:; img-src 'self' data: blob:; font-src 'self' data:; " +
  "media-src 'self' data: blob:; worker-src blob:; form-action 'none'";

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
