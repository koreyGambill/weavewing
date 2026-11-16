/** Only an inline data: favicon, so rendering a tool row contacts no site (weavewingOutbound). */
function localFaviconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 65_536) return null;
  return /^data:image\//i.test(rawUrl) ? rawUrl : null;
}

export function toolActivityFaviconUrl(
  icon: {
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
): string | null {
  return appearance === "dark"
    ? (localFaviconUrl(icon.faviconUrlDark) ?? localFaviconUrl(icon.faviconUrl))
    : localFaviconUrl(icon.faviconUrl);
}
