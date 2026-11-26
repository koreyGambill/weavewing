export const RELEASE_REPOSITORY = "koreyGambill/weavewing";
export const RELEASE_TAG_PREFIX = "weavewing-v";
/**
 * The desktop app id on Windows and Linux. Windows derives the NSIS install and uninstall
 * registry GUID and the AppUserModelID of shortcuts and windows from it, so a new value installs
 * a second copy beside existing installs instead of upgrading them.
 */
export const DESKTOP_APP_ID = "dev.weavewing.desktop";
/**
 * The macOS bundle identifier. Developer ID signing, provisioning profiles and Squirrel.Mac
 * update matching bind to it, so it must not change once a signed build ships.
 */
export const MACOS_BUNDLE_ID = "dev.wingstack.weavewing.desktop";
/** Where to get the `t3` CLI; the npm package `t3` is upstream's. */
export const CLI_INSTALL_GUIDE_URL = `https://github.com/${RELEASE_REPOSITORY}/blob/main/docs/user/install.md#command-line`;

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
