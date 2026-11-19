import {
  type AuthClientSession,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../../test/render";
import { buildReachModel, type ReachServerInput } from "./reachModel.logic";
import { ReachGrid } from "./ReachGrid";
import type { SquareChangeState } from "./useSquareChange";

const WSL = EnvironmentId.make("grid-wsl");
const MOON = EnvironmentId.make("grid-moon");

const server = (
  overrides: Partial<ReachServerInput> & Pick<ReachServerInput, "environmentId" | "label">,
): ReachServerInput => ({
  onThisComputer: false,
  sharesHostLoopback: false,
  route: "direct",
  routeUrl: null,
  reachableFromOthers: true,
  linksOffered: true,
  canManage: true,
  appScopes: [...AuthStandardClientScopes],
  sessions: [],
  links: [],
  ...overrides,
});

const phone: AuthClientSession = {
  sessionId: AuthSessionId.make("grid-phone"),
  subject: "browser",
  scopes: [...AuthStandardClientScopes],
  method: "bearer-access-token",
  client: { deviceType: "mobile", label: "Phone" },
  issuedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(10_000),
  lastConnectedAt: null,
  connected: true,
  current: false,
};

function setup() {
  const request = vi.fn();
  const change: SquareChangeState = {
    pending: null,
    busyKey: null,
    errors: new Map(),
    request,
    confirm: vi.fn(),
    cancel: vi.fn(),
    applyNow: vi.fn(),
  };
  const model = buildReachModel({
    servers: [
      server({ environmentId: WSL, label: "WSL", sessions: [phone] }),
      server({ environmentId: MOON, label: "Moonborn", canManage: false, sessions: null }),
    ],
  });
  return { model, change, request };
}

describe("ReachGrid", () => {
  it("pins a square's popup on click without changing its level, and changes it only from the popup", async () => {
    const { model, change, request } = setup();
    await using _screen = await render(<ReachGrid model={model} change={change} />);

    await userEvent.click(page.getByRole("button", { name: "From Moonborn to WSL: No access" }));

    await expect.element(page.getByText("From WSL to Moonborn: No access")).toBeVisible();
    expect(request).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Full access", exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByText("Changing the level needs this app to manage Moonborn too"))
      .toBeVisible();
  });

  it("offers removal of a device from the popup and nothing that pretends to change its level", async () => {
    const { model, change, request } = setup();
    await using _screen = await render(<ReachGrid model={model} change={change} />);

    await userEvent.click(page.getByRole("button", { name: "From Phone to WSL: Full access" }));
    await expect
      .element(
        page.getByText("A device keeps the level it paired with. Pair it again to change it."),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "No access", exact: true }));

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.objectContaining({ label: "Phone" }) }),
      "none",
    );
  });

  it("locks a column this app cannot manage and says where it is set", async () => {
    const { model, change } = setup();
    await using _screen = await render(<ReachGrid model={model} change={change} />);

    await expect.element(page.getByRole("img", { name: "Set on that machine" })).toBeVisible();
    await userEvent.click(
      page.getByRole("button", { name: "From This app to Moonborn: Full access" }),
    );
    await expect
      .element(page.getByText("Moonborn decides this. This app does not have full access to it."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "View only" })).not.toBeInTheDocument();
  });

  it("keeps one tab stop, moves with the arrow keys, and returns focus to the square on Escape", async () => {
    const { model, change } = setup();
    await using screen = await render(<ReachGrid model={model} change={change} />);

    const tabbable = screen.container.querySelectorAll("td button[tabindex='0']");
    expect(tabbable).toHaveLength(1);
    const first = page.getByRole("button", { name: "From Moonborn to WSL: No access" });
    await userEvent.click(first);
    await userEvent.keyboard("{Escape}");
    await expect.element(first).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("button", { name: "From This app to WSL: Full access" }))
      .toHaveFocus();
  });
});
