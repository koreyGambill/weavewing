import { describe, expect, it } from "@effect/vitest";

import { toolActivityFaviconUrl } from "./favicon.ts";

describe("toolActivityFaviconUrl", () => {
  const dataIcon = "data:image/png;base64,iVBORw0KGgo=";

  it("never derives a URL that contacts the visited site", () => {
    expect(toolActivityFaviconUrl({}, "light")).toBeNull();
    expect(toolActivityFaviconUrl({ faviconUrl: "https://example.com/icon.png" }, "light")).toBe(
      null,
    );
    expect(
      toolActivityFaviconUrl({ faviconUrl: "chrome-extension://example/_favicon/" }, "dark"),
    ).toBeNull();
  });

  it("keeps an inline favicon a provider already sent", () => {
    expect(toolActivityFaviconUrl({ faviconUrl: dataIcon }, "light")).toBe(dataIcon);
    expect(
      toolActivityFaviconUrl(
        { faviconUrl: dataIcon, faviconUrlDark: "https://example.com/dark.png" },
        "dark",
      ),
    ).toBe(dataIcon);
  });
});
