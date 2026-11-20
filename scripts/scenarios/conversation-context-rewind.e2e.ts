import { expect } from "e2e";
import { test, WEB } from "./t3.ts";

test(
  "rewinds context and can bring the archived conversation back into a draft",
  WEB,
  async ({ app, screen, t3 }) => {
    const project = await t3.project("context-rewind");
    const thread = await t3.thread({
      project,
      title: "Context rewind demo",
      messages: ["A prompt to archive"],
    });
    await t3.open(thread);
    await expect(screen.getByRole("heading", "Context rewind demo")).toBeVisible({
      timeout: 60_000,
    });
    const reply = screen.getByText("first fixture turn complete", { exact: true });
    await expect(reply).toBeVisible();
    const composer = screen.getByRole("textbox", "Message Context rewind demo");
    await composer.fill("My next prompt");
    await screen.getByRole("button", "Rewind conversation context").tap();
    await screen.getByRole("button", "Confirm").tap();

    const archive = screen.getByRole("button", "Earlier conversation");
    await expect(archive).toHaveAttribute("aria-expanded", "false");
    await expect(reply).toHaveCount(0);
    await app.screenshot("history-collapsed");
    await screen.getByRole("button", "Toggle earlier conversation").tap();
    await expect(reply).toBeVisible();
    await app.screenshot("history-expanded");
    await screen.getByRole("button", "Bring back").tap();
    await expect(composer).toContainText("My next prompt");
    await expect(screen.getByRole("link", /^Thread, Earlier conversation/)).toBeVisible();
  },
);
