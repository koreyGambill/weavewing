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
import { buildReachModel, type ReachServerInput, squareKey } from "./reachModel.logic";
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
  servedByTailscale: false,
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
    uncertain: new Set(),
    linkAgain: vi.fn(),
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

  it("claims no level for a line whose relink was left uncertain", async () => {
    const { model, change } = setup();
    const square = [...model.squares.values()].find(
      (candidate) => candidate.from.label === "Moonborn" && candidate.to.label === "WSL",
    )!;
    const uncertain = { ...change, uncertain: new Set([squareKey(square.from.id, square.to.id)]) };
    await using screen = await render(<ReachGrid model={model} change={uncertain} />);

    await userEvent.click(page.getByRole("button", { name: "From Moonborn to WSL: Uncertain" }));

    await expect.element(page.getByText("From Moonborn to WSL: Uncertain")).toBeVisible();
    expect(screen.container.ownerDocument.querySelectorAll("[aria-pressed='true']")).toHaveLength(
      0,
    );
  });

  it("offers removal of a device from the popup and nothing that pretends to change its level", async () => {
    const { model, change, request } = setup();
    await using _screen = await render(<ReachGrid model={model} change={change} />);

    await userEvent.click(page.getByRole("button", { name: "From Phone to WSL: Full access" }));
    await expect
      .element(page.getByRole("button", { name: "Ask before changes" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Full access", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Remove access" }));

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

  it("keeps one tab stop across headers and squares, moves with the arrow keys, and returns focus on Escape", async () => {
    const { model, change } = setup();
    await using screen = await render(<ReachGrid model={model} change={change} />);
    const focusable = () =>
      [
        ...screen.container
          .querySelector("table")!
          .querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]"),
      ].filter((element) => element.tabIndex >= 0);

    expect(focusable()).toHaveLength(1);
    const first = page.getByRole("button", { name: "From Moonborn to WSL: No access" });
    await userEvent.click(first);
    await userEvent.keyboard("{Escape}");
    await expect.element(first).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("button", { name: "From This app to WSL: Full access" }))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect
      .element(page.getByRole("button", { name: "From This app (you)", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    await expect.element(page.getByRole("button", { name: "From WSL", exact: true })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowUp}");
    await expect.element(page.getByRole("button", { name: "To WSL", exact: true })).toHaveFocus();
    expect(focusable()).toHaveLength(1);
  });
});
