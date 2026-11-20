import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// The replay provider rejects title generation. Reaching it proves the inherited history was accepted.
test(
  "Regenerate title on a fresh fork reaches the title model with the inherited history",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Earlier work", messages: ["first"] });
    await t3.open(thread);

    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
    await screen.getByRole("button", "Fork from this response").first().tap();
    await expect(screen.getByRole("tab", "Earlier work fork")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(screen.getByRole("tab", "Main chat").first()).toBeVisible();
    const forkActions = screen.getByRole("button", "Thread actions for Earlier work fork");
    await expect(forkActions).toBeVisible();

    await forkActions.tap();
    await screen.getByRole("menuitem", "Regenerate title").tap();
    await expect(screen.getByText("Failed to regenerate thread title")).toBeVisible();
    await app.screenshot("regenerate-result");
    await expect(
      screen.getByText("do not provide application text generation", { exact: false }),
    ).toBeVisible();

    await screen.getByRole("tab", "Main chat").first().tap();
    const parentDraft = screen.getByRole("textbox", "Message Earlier work");
    await parentDraft.fill("Compare the alternatives.");
    await screen.getByRole("tab", "Earlier work fork").tap();
    const forkDraft = screen.getByRole("textbox", "Message Earlier work fork");
    await forkDraft.fill("Explore the second option.");
    await forkDraft.press("Enter");
    await screen.getByRole("button", "Bring back").tap();
    await expect(parentDraft).toContainText("Compare the alternatives.");
    await expect(screen.getByRole("link", "Thread, Explore the second option.")).toBeVisible();
    await app.screenshot("fork-reference-in-main-chat");
    await screen.getByRole("button", "Lineage", { exact: true }).tap();
    await screen.getByRole("button", "How conversation context is shared").tap();
    await expect(
      screen.getByText("Long histories may leave items out.", { exact: false }),
    ).toBeVisible();
    await app.screenshot("context-explainer");
  },
);
