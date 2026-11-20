import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test(
  "opens a side chat from an assistant selection and navigates back to it",
  WEB,
  async ({ app, browser, screen, t3 }) => {
    const project = await t3.project("side-chat-demo");
    const thread = await t3.thread({ project, title: "Main conversation", messages: ["Start"] });
    await t3.open(thread);
    await expect(screen.getByRole("heading", "Main conversation")).toBeVisible({
      timeout: 60_000,
    });
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
    const childPrompts = screen.getByRole("textbox", "Message Side chat");
    await childPrompts.first().fill("Go one level deeper.");
    await childPrompts.first().press("Enter");
    const deepestReply = browser.locator(
      "[data-side-chat-pane] [data-side-chat-pane] [data-side-chat-source]",
    );
    await expect(deepestReply.first()).toContainText("fixture turn complete");
    await browser.evaluate(() => {
      const source = document.querySelector(
        "[data-side-chat-pane] [data-side-chat-pane] [data-side-chat-source]",
      );
      if (!source) throw new Error("Missing second-level reply.");
      source.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(source);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return null;
    });
    await screen.getByRole("button", "Drill in").tap();
    await expect(fullChat).toHaveCount(3);
    await expect(browser.locator("[data-minimap-side-chat]")).toHaveCount(3);
    const layout = await browser.evaluate(() => {
      const transcripts = [...document.querySelectorAll("[data-inline-side-chat-transcript]")];
      const scrollOwners = transcripts.map((transcript) => {
        for (let node = transcript.parentElement; node; node = node.parentElement) {
          if (
            /^(auto|scroll)$/.test(getComputedStyle(node).overflowY) &&
            node.scrollHeight > node.clientHeight + 1
          ) {
            return node;
          }
        }
        return null;
      });
      const colors = transcripts.map((transcript) => {
        const rail = transcript.closest("[data-side-chat-pane]")?.parentElement;
        return rail ? getComputedStyle(rail).borderLeftColor : null;
      });
      return {
        count: transcripts.length,
        sharedScroll: scrollOwners[0] !== null && new Set(scrollOwners).size === 1,
        distinctRails: new Set(colors).size,
      };
    });
    if (layout.count !== 3 || !layout.sharedScroll || layout.distinctRails !== 3) {
      throw new Error(`Expected three rails in one scroller: ${JSON.stringify(layout)}`);
    }
    await app.screenshot("three-levels-one-scroll");
    const rails = screen.getByRole("button", /^Toggle drill-in:/);
    await rails.first().tap();
    await expect(rails).toHaveCount(3);
    await expect(rails.first()).toHaveAttribute("aria-expanded", "false");
    await expect(fullChat).toHaveCount(2);
    await rails.nth(1).tap();
    await expect(fullChat).toHaveCount(1);
    await rails.nth(1).tap();
    await expect(fullChat).toHaveCount(2);
    await expect(rails.first()).toHaveAttribute("aria-expanded", "false");
    await browser.evaluate(() => {
      document
        .querySelector('[aria-label^="Toggle drill-in:"]')
        ?.nextElementSibling?.scrollIntoView({
          block: "start",
        });
      return null;
    });
    await app.screenshot("collapsed-parent-open-descendants");
    await rails.first().tap();
    await expect(fullChat).toHaveCount(3);
    await screen.getByRole("button", "Open as side chat tab").last().tap();
    await expect(screen.getByRole("button", "Close side chat")).toBeVisible();
    await screen.getByRole("button", "Close side chat").tap();
    const firstBranchDraft = screen.getByRole("textbox", /^Message Explain that/);
    await firstBranchDraft.fill("Compare this with the first approach.");
    await screen.getByRole("button", /^Bring back to Explain that/).tap();
    await expect(firstBranchDraft).toContainText("Compare this with the first approach.");
    await expect(screen.getByRole("link", "Thread, Go one level deeper.")).toBeVisible();

    const mainComposer = screen.getByRole("textbox", "Message Main conversation");
    await mainComposer.fill("/side Check this next.");
    await mainComposer.press("Enter");
    await expect(screen.getByRole("button", "Close side chat")).toBeVisible();
    await screen.getByRole("tab", "Main chat").tap();
    const plainRail = screen.getByRole("button", /^Toggle side chat:/);
    await plainRail.tap();
    await expect(plainRail).toHaveAttribute("aria-expanded", "true");
    await plainRail.tap();
    await expect(plainRail).toHaveAttribute("aria-expanded", "false");
  },
);
