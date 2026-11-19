import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test(
  "opens a side chat from an assistant selection and navigates back to it",
  WEB,
  async ({ app, browser, screen, t3 }) => {
    const project = await t3.project("side-chat-demo");
    const thread = await t3.thread({ project, title: "Main conversation", messages: ["Start"] });
    await t3.open(thread);
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await browser.evaluate(() => {
      const source = [...document.querySelectorAll("[data-side-chat-source]")].find((node) =>
        node.textContent?.includes("first fixture turn complete"),
      );
      if (!source) throw new Error("Replay reply did not provide a side-chat selection source.");
      source.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(source);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return null;
    });
    await screen.getByRole("button", "Drill in").tap();
    const fullChat = screen.getByRole("button", "Open full chat");
    await expect(fullChat).toBeVisible();
    const refresh = screen.getByRole("button", "Get newest context");
    await expect(refresh.first()).toBeVisible();
    await refresh.first().tap();
    await expect(refresh.first()).toHaveAttribute("aria-pressed", "true");
    await app.screenshot("expanded-inline-branch");
    await fullChat.tap();
    await screen.getByRole("button", /^Jump to source:/).tap();
    await expect(fullChat).toBeVisible();
    await expect(refresh.first()).toHaveAttribute("aria-pressed", "true");
    const branchComposer = screen.getByRole("textbox", "Message Side chat");
    await branchComposer.fill("Explain that in more detail.");
    await branchComposer.press("Enter");
    await expect(refresh.first()).toHaveAttribute("aria-pressed", "false");
    const branchReply = browser.locator("[data-side-chat-pane] [data-side-chat-source]");
    await expect(branchReply.first()).toContainText("fixture turn complete");
    await browser.evaluate(() => {
      const source = document.querySelector("[data-side-chat-pane] [data-side-chat-source]");
      if (!source) throw new Error("The nested reply has no selection source.");
      source.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(source);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return null;
    });
    await screen.getByRole("button", "Drill in").tap();
    await expect(fullChat).toHaveCount(2);
  },
);
