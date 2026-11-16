import { describe, expect, it } from "@effect/vitest";

import { agentHtmlNavigationBlocked } from "./weavewingOutbound.ts";

describe("agentHtmlNavigationBlocked", () => {
  const page = "http://127.0.0.1:3773/api/assets/token/render.html";

  it.each([
    "http://127.0.0.1:19322/navigation?canary=1",
    "https://evil.example/?phi=1",
    "http://127.0.0.1:3773/api/state",
    "data:text/html,<img src=https://evil.example/>",
    "blob:http://127.0.0.1:3773/0c7f",
    "not a url",
  ])("keeps agent HTML from navigating to %s", (target) => {
    expect(agentHtmlNavigationBlocked(page, target)).toBe(true);
  });

  it.each(["http://127.0.0.1:3773/api/assets/token/render.html?v=2", "about:blank"])(
    "lets the app reload the page at %s",
    (target) => {
      expect(agentHtmlNavigationBlocked(page, target)).toBe(false);
    },
  );

  it("leaves frames that are not asset-route pages to their own rules", () => {
    expect(agentHtmlNavigationBlocked("about:blank", page)).toBe(false);
    expect(agentHtmlNavigationBlocked("https://mcp.example/app", "https://evil.example/")).toBe(
      false,
    );
  });
});
