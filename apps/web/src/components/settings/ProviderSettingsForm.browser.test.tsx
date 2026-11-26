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

it("starts with every built-in tool unticked and keeps focus on the actions after using them", async () => {
  await using screen = await render(<ClaudeForm />);
  const recommended = screen.getByRole("button", { name: "Recommended" });
  const artifactsOnly = screen.getByRole("button", { name: "Artifact tools only" });
  const allTools = screen.getByRole("button", { name: "All tools" });
  const task = screen.getByRole("checkbox", { name: "Task (Agent)" });
  const artifact = screen.getByRole("checkbox", { name: "Artifact" });

  await expect
    .element(task)
    .toHaveAccessibleDescription("Run Claude's own subagents About 3,300 tokens, an estimate");
  await expect.element(task).not.toBeChecked();
  await expect.element(artifact).not.toBeChecked();
  await expect.element(recommended).toHaveAttribute("aria-disabled", "true");

  (artifactsOnly.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(artifact).toBeChecked();
  await expect.element(task).not.toBeChecked();
  await expect.element(artifactsOnly).toHaveAttribute("aria-disabled", "true");
  expect(document.activeElement).toBe(artifactsOnly.element());

  (allTools.element() as HTMLElement).focus();
  await userEvent.keyboard(" ");
  await expect.element(task).toBeChecked();
  await expect.element(allTools).toHaveAttribute("aria-disabled", "true");
  expect(document.activeElement).toBe(allTools.element());

  await userEvent.click(recommended);
  await expect.element(task).not.toBeChecked();
  await expect.element(artifact).not.toBeChecked();
  await expect.element(recommended).toHaveAttribute("aria-disabled", "true");
});

it("saves a ticked tool as kept and an unticked one as left out", async () => {
  const saved: Array<unknown> = [];
  function RecordingForm() {
    const [value, setValue] = useState<Record<string, unknown> | undefined>(undefined);
    return (
      <ProviderSettingsForm
        definition={providerClients.get(ProviderDriverKind.make("claudeAgent"))!}
        value={value}
        idPrefix="claude"
        variant="dialog"
        onChange={(next) => {
          saved.push(next);
          setValue(next);
        }}
      />
    );
  }
  await using screen = await render(<RecordingForm />);
  const task = screen.getByRole("checkbox", { name: "Task (Agent)" });
  (task.element() as HTMLElement).focus();
  await userEvent.keyboard(" ");
  await expect.element(task).toBeChecked();
  expect(saved.at(-1)).toEqual({
    omittedBuiltinTools: [
      "Artifact",
      "ArtifactData",
      "ArtifactComments",
      "Workflow",
      "ScheduleWakeup",
      "ReportFindings",
    ],
  });
  await userEvent.keyboard(" ");
  await expect.element(task).not.toBeChecked();
  expect(saved.at(-1)).toEqual({
    omittedBuiltinTools: [
      "Artifact",
      "ArtifactData",
      "ArtifactComments",
      "Task",
      "Workflow",
      "ScheduleWakeup",
      "ReportFindings",
    ],
  });
});
