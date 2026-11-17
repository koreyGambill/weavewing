export const RELEASE_REPOSITORY = "koreyGambill/weavewing";
export const RELEASE_TAG_PREFIX = "weavewing-v";
export const DESKTOP_APP_ID = "dev.weavewing.desktop";

/** The GitHub tag for a Weavewing release version. */
export function releaseTag(version: string): string {
  return `${RELEASE_TAG_PREFIX}${version}`;
}

/** A version from a fork tag, excluding upstream tags mirrored into the repository. */
export function releaseVersionFromTag(tag: string): string | undefined {
  if (!tag.startsWith(RELEASE_TAG_PREFIX)) return undefined;
  const version = tag.slice(RELEASE_TAG_PREFIX.length);
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
}
