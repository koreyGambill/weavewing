import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { environmentPresentations } from "../../state/presentation";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarUsageLimits } from "./SidebarUsageLimits";

vi.mock("../../state/presentation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/presentation")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...original,
    environmentPresentations: {
      ...original.environmentPresentations,
      presentationsWithProvidersAtom: Atom.make<LimitPresentations>(new Map()),
    },
  };
});

vi.mock("../../hooks/useDeadline", () => ({ useDeadlinePassed: () => false }));

const checkedAt = "2026-11-19T15:00:00Z";

function provider(
  driver: string,
  displayName: string,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

it("opens detailed limits and provider warnings from the subscription buttons", async () => {
  const presentations: LimitPresentations = new Map([
    [
      EnvironmentId.make("fixture"),
      {
        entry: { target: { label: "Fixture" } },
        serverConfig: {
          providers: [
            provider("codex", "Codex", {
              checkedAt,
              windows: [
                {
                  id: "weekly",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 75,
                  resetsAt: "2026-11-20T15:00:00Z",
                  windowDurationMins: 7 * 24 * 60,
                },
                { id: "session", kind: "session", label: "Session", usedPercent: 32 },
              ],
              resetCredits: { availableCount: 2 },
            }),
            provider("claudeAgent", "Claude", {
              checkedAt,
              windows: [],
              unavailable: { reason: "probeFailed", message: "Claude returned no limit values." },
            }),
          ],
        },
      },
    ],
  ]);
  await using screen = await render(
    <RegistryProvider
      initialValues={[[environmentPresentations.presentationsWithProvidersAtom, presentations]]}
    >
      <TooltipProvider>
        <SidebarUsageLimits />
      </TooltipProvider>
    </RegistryProvider>,
  );

  const codex = screen.getByRole("button", { name: "Codex: Weekly · 25% left" });
  await userEvent.click(codex);
  const details = screen.getByRole("dialog", { name: "Codex usage limits" });
  await expect.element(details.getByText("25% left", { exact: true })).toBeVisible();
  await expect.element(details.getByText("68% left", { exact: true })).toBeVisible();
  await expect.element(details.getByText("2 reset credits available")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(details).not.toBeInTheDocument();

  const claude = screen.getByRole("button", { name: "Claude: Usage unavailable" });
  claude.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      screen
        .getByRole("dialog", { name: "Claude usage limits" })
        .getByText("Claude returned no limit values."),
    )
    .toBeVisible();
});
