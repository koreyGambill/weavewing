import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { useState } from "react";
import { render } from "../../../test/render";

const { updateSettings, state } = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  state: { policy: undefined as ManagedPolicySummary | undefined },
}));
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useUpdateEnvironmentSettings: () => updateSettings,
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/managedPolicy", async (original) => ({
  ...(await original<typeof import("../../state/managedPolicy")>()),
  useManagedPolicy: () => state.policy,
}));

import { TailnetPairingRow } from "./TailnetPairingRow";

function Row({ enabled = false, managed }: { enabled?: boolean; managed?: string }) {
  const [settings, setSettings] = useState({ ...DEFAULT_SERVER_SETTINGS.tailnetConnect, enabled });
  updateSettings.mockImplementation((patch) =>
    setSettings({ ...settings, ...patch.tailnetConnect }),
  );
  return (
    <TailnetPairingRow
      environmentId={EnvironmentId.make("privacy-test")}
      environmentLabel="Test computer"
      settings={settings}
      managed={managed}
      privacy
    />
  );
}

it.each([false, true])(
  "prints the lock reason and prevents changing a setting locked to %s",
  async (enabled) => {
    state.policy = { organization: "Northwind Health", lockedSettings: ["tailnetConnect.enabled"] };
    updateSettings.mockReset();
    await using screen = await render(<Row enabled={enabled} />, { router: "/settings/privacy" });
    await expect
      .element(screen.getByText("Managed by Northwind Health.", { exact: true }))
      .toBeVisible();
    const toggle = screen.container.querySelector('[role="switch"]');
    expect(toggle?.closest("[inert]")).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe(String(enabled));
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(updateSettings).not.toHaveBeenCalled();
  },
);

it("allows turning pairing off under a remote denial, then prevents turning it back on", async () => {
  state.policy = undefined;
  updateSettings.mockReset();
  const denial = "Northwind Health's policy does not allow remote clients.";
  await using screen = await render(<Row enabled managed={denial} />, {
    router: "/settings/privacy",
  });
  const toggle = () => screen.container.querySelector<HTMLElement>('[role="switch"]')!;
  expect(toggle().closest("[inert]")).toBeNull();
  toggle().focus();
  await userEvent.keyboard(" ");
  await vi.waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
  expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ tailnetConnect: { enabled: false } });
  expect(toggle().closest("[inert]")).not.toBeNull();
  await userEvent.tab();
  await userEvent.keyboard(" ");
  expect(updateSettings).toHaveBeenCalledTimes(1);
});
