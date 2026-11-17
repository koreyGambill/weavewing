import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliArchiveFileName,
  cliReleaseDownloadBaseUrl,
  cliReleaseAssetUrl,
  cliReleaseIndexPageUrl,
  CLI_RELEASES_PAGE_URL,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("downloads fork archives and checksums using fork tags, including mirrors", () => {
    expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/koreyGambill/weavewing/releases");
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/koreyGambill/weavewing/releases?per_page=100&page=2",
    );
    expect(cliReleaseDownloadBaseUrl("1.0.0")).toBe(
      "https://github.com/koreyGambill/weavewing/releases/download/weavewing-v1.0.0",
    );
    for (const key of ["darwin-arm64", "linux-x64", "win32-x64"] as const) {
      const archive = cliArchiveFileName("1.0.0", key);
      expect(archive).toBe(`t3-1.0.0-${key}.${key.startsWith("win32") ? "zip" : "tar.gz"}`);
      expect(cliReleaseAssetUrl("1.0.0", archive)).toBe(
        `https://github.com/koreyGambill/weavewing/releases/download/weavewing-v1.0.0/${archive}`,
      );
    }
    expect(
      cliReleaseAssetUrl("1.0.0", "SHA256SUMS", "https://mirror.test/download/?token=abc"),
    ).toBe("https://mirror.test/download/weavewing-v1.0.0/SHA256SUMS?token=abc");
    expect(cliReleaseDownloadBaseUrl("1.0.0", "https://mirror.test/download///")).toBe(
      "https://mirror.test/download/weavewing-v1.0.0",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v99.0.0" },
      { tag_name: "weavewing-v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "weavewing-v1.2.4-preview.20260912.8" },
      { tag_name: "weavewing-v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "weavewing-v1.2.3" },
      { tag_name: "weavewing-v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "weavewing-v1.2.3" }], "preview")).toBeUndefined();
  });
});
