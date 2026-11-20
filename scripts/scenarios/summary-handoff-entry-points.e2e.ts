import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test("Completed replies expose a bounded summary handoff", WEB, async ({ t3, app, screen }) => {
  const project = await t3.project("Handoff proof");
  const thread = await t3.thread({
    project,
    title: "Conversation to hand off",
    messages: ["Show the completed reply."],
  });
  await t3.open(thread);
  await screen.getByRole("region", "Conversation", { exact: true }).waitFor({ timeout: 120_000 });
  await app.screenshot("handoff-actions");
  await expect(screen.getByRole("button", "Hand off", { exact: true })).toBeVisible();
  const fromReply = screen.getByRole("button", "Hand off from here", { exact: true });
  await expect(fromReply).toBeVisible();
  await fromReply.tap();
  await expect(screen.getByRole("button", "Summary model", { exact: true })).toBeVisible();
  await app.screenshot("bounded-summary-dialog");
});
