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

it("keeps keyboard focus on the built-in tool actions after using them", async () => {
  await using screen = await render(<ClaudeForm />);
  const preset = screen.getByRole("button", { name: "Leave out all seven" });
  const clear = screen.getByRole("button", { name: "Clear" });
  const task = screen.getByRole("checkbox", { name: "Task (Agent)" });

  await expect
    .element(task)
    .toHaveAccessibleDescription(
      "No native subagents; skills that fan out through them must use delegate_task instead.",
    );

  (preset.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(task).toBeChecked();
  expect(document.activeElement).toBe(preset.element());

  (clear.element() as HTMLElement).focus();
  await userEvent.keyboard(" ");
  await expect.element(task).not.toBeChecked();
  expect(document.activeElement).toBe(clear.element());
});
