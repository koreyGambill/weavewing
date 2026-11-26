import { describe, expect, it, vi } from "vite-plus/test";

import {
  isLegalDocumentUrl,
  LEGAL_DOCUMENT_ORIGIN_WHITELIST,
  LEGAL_URL,
  shouldLoadLegalDocument,
} from "./legal-document-url";

const linking = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => true),
}));
vi.mock("react-native", () => ({
  Linking: linking,
  Platform: { OS: "ios" },
  StyleSheet: { create: <T>(styles: T) => styles },
}));

describe("isLegalDocumentUrl", () => {
  it("opens the legal page on the Weavewing site", () => {
    expect(LEGAL_URL).toBe("https://weavewing.wingstack.dev/legal");
  });

  it.each([
    "https://weavewing.wingstack.dev/privacy-policy",
    "https://weavewing.wingstack.dev/terms-of-service/",
  ])("accepts a published legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each(["https://example.com/legal", "https://t3.codes/legal", "javascript:alert(1)"])(
    "rejects a URL outside the legal-document allowlist: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(false);
    },
  );
});

type WebViewShared = typeof import("react-native-webview/lib/WebViewShared");

// The library's own handler applies the whitelist before the screen's callback sees the request.
describe("legal document navigation", () => {
  async function navigate(url: string) {
    // The source build honours the react-native mock; the published types describe the same API.
    const { createOnShouldStartLoadWithRequest }: WebViewShared = await import(
      "react-native-webview/src/WebViewShared" as string
    );
    const loadRequest = vi.fn();
    createOnShouldStartLoadWithRequest(
      loadRequest,
      LEGAL_DOCUMENT_ORIGIN_WHITELIST,
      shouldLoadLegalDocument,
    )({ nativeEvent: { url, lockIdentifier: 1, isTopFrame: true } } as Parameters<
      ReturnType<typeof createOnShouldStartLoadWithRequest>
    >[0]);
    return loadRequest.mock.calls[0]?.[0];
  }

  it("loads a published legal document in place", async () => {
    expect(await navigate("https://weavewing.wingstack.dev/privacy-policy")).toBe(true);
    expect(linking.canOpenURL).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/elsewhere",
    "http://weavewing.wingstack.dev/legal",
    "mailto:someone@example.com",
    "tel:+15555550100",
    "t3code://pair",
    "javascript:alert(1)",
  ])("drops %s without handing it to the system", async (url) => {
    expect(await navigate(url)).toBe(false);
    expect(linking.canOpenURL).not.toHaveBeenCalled();
    expect(linking.openURL).not.toHaveBeenCalled();
  });
});
