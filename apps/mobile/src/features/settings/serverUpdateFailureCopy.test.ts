import { describe, expect, it } from "vite-plus/test";

import { serverUpdateFailureCopy } from "./serverUpdateFailureCopy";

describe("serverUpdateFailureCopy", () => {
  it("rewords the missing background service failure", () => {
    expect(
      serverUpdateFailureCopy(
        "Server update failed: Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
      ),
    ).toBe(
      "Remote updates need the Weavewing background service. Run `t3 service install` on that machine.",
    );
  });

  it("rewords the desktop-managed failure", () => {
    expect(
      serverUpdateFailureCopy(
        "Server update failed: This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",
      ),
    ).toBe(
      "The Weavewing desktop app on that machine runs this server. Update the desktop app to update it.",
    );
  });

  it("keeps an unknown failure's detail and swaps only the product name", () => {
    expect(
      serverUpdateFailureCopy(
        "Server update failed: Example Corp manages T3 Code updates. Only stable releases can be installed.",
      ),
    ).toBe(
      "Server update failed: Example Corp manages Weavewing updates. Only stable releases can be installed.",
    );
  });

  it("keeps an unbranded failure's detail", () => {
    expect(
      serverUpdateFailureCopy("Server update failed: A server update is already in progress."),
    ).toBe("Server update failed: A server update is already in progress.");
  });
});
