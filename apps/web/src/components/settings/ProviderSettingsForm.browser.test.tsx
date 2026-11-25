import { ProviderDriverKind } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { providerClients } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

function ClaudeForm() {
  const [value, setValue] = useState<Record<string, unknown> | undefined>(undefined);
  return (
    <ProviderSettingsForm
      definition={providerClients.get(ProviderDriverKind.make("claudeAgent"))!}
      value={value}
      idPrefix="claude"
      variant="dialog"
      onChange={setValue}
    />
  );
}

it("starts on the recommended built-in tools and keeps focus on the actions after using them", async () => {
  await using screen = await render(<ClaudeForm />);
  const recommended = screen.getByRole("button", { name: "Recommended" });
  const keepArtifacts = screen.getByRole("button", { name: "Keep artifact tools" });
  const clear = screen.getByRole("button", { name: "Clear" });
  const task = screen.getByRole("checkbox", { name: "Task (Agent)" });
  const artifact = screen.getByRole("checkbox", { name: "Artifact" });

  await expect
    .element(task)
    .toHaveAccessibleDescription(
      "No native subagents; skills that fan out through them must use delegate_task instead.",
    );
  await expect.element(task).toBeChecked();
  await expect.element(artifact).toBeChecked();
  await expect.element(recommended).toHaveAttribute("aria-disabled", "true");

  (keepArtifacts.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(artifact).not.toBeChecked();
  await expect.element(task).toBeChecked();
  await expect.element(keepArtifacts).toHaveAttribute("aria-disabled", "true");
  expect(document.activeElement).toBe(keepArtifacts.element());

  (clear.element() as HTMLElement).focus();
  await userEvent.keyboard(" ");
  await expect.element(task).not.toBeChecked();
  await expect.element(clear).toHaveAttribute("aria-disabled", "true");
  expect(document.activeElement).toBe(clear.element());

  await userEvent.click(recommended);
  await expect.element(task).toBeChecked();
  await expect.element(artifact).toBeChecked();
  await expect.element(recommended).toHaveAttribute("aria-disabled", "true");
});
