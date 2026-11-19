import {
  AuthStandardClientScopes,
  EnvironmentId,
  managedCapabilityDenial,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../../test/render";
import { ConnectWizard, PairDeviceForm } from "./ConnectWizard";
import { openConnectWizard } from "./connectWizardStore";
import { buildReachModel } from "./reachModel.logic";
import type { SquareChangeState } from "./useSquareChange";
import type { ReachServer } from "./useReachModel";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
  connectPairing: vi.fn(),
}));

vi.mock(import("~/connection/onboarding"), async (original) => ({
  ...(await original()),
  connectPairing: state.connectPairing as never,
}));

vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => state.primaryEnvironmentId) as never,
}));
vi.mock(import("../../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...state.policies].map(([environmentId, managedPolicy]) => [
        environmentId,
        { managedPolicy },
      ]),
    )) as never,
}));
vi.mock(import("../../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentSessionState: (() => ({
    data: { authenticated: true, scopes: [...AuthStandardClientScopes] },
    hasError: false,
    isPending: false,
  })) as never,
}));
vi.mock(import("../../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === state.connectPairing ? command : vi.fn()) as never,
}));

const remoteClientsOff: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { clients: ["desktop"] },
};

function setup(policies: ReadonlyArray<readonly [EnvironmentId, ManagedPolicySummary]>) {
  state.primaryEnvironmentId = localId;
  state.policies = new Map(policies);
}

const service = {
  environment: {
    environmentId: serviceId,
    label: "Service",
    serverConfig: null,
    entry: { target: { _tag: "BearerConnectionTarget", connectionId: "remote:service" } },
  },
  input: { environmentId: serviceId, label: "Service", canManage: true },
} as unknown as ReachServer;

describe("PairDeviceForm", () => {
  const denial = managedCapabilityDenial(remoteClientsOff, "remoteClients")!;

  it("follows the chosen server's policy, not the primary's", async () => {
    setup([[serviceId, remoteClientsOff]]);
    await using screen = await render(<PairDeviceForm servers={[service]} qr />);

    await expect.element(screen.getByRole("group", { name: denial })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create QR code" })).toBeDisabled();
  });

  it("leaves pairing open on an unmanaged server when the primary is managed", async () => {
    setup([[localId, remoteClientsOff]]);
    await using screen = await render(<PairDeviceForm servers={[service]} qr={false} />);

    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("group", { name: denial }).query()).toBeNull();
  });
});

describe("ConnectWizard", () => {
  it("adds a computer in place on the How step, without opening another dialog", async () => {
    setup([]);
    state.connectPairing.mockResolvedValue(AsyncResult.success(undefined));
    const change = {} as SquareChangeState;
    openConnectWizard("computer");
    await using _screen = await render(
      <ConnectWizard model={buildReachModel({ servers: [] })} servers={[]} change={change} />,
    );

    await userEvent.fill(
      page.getByPlaceholder("backend.example.com"),
      "http://box:3773/pair#token=ABCD1234",
    );
    await expect.element(page.getByPlaceholder("PAIRCODE")).toHaveValue("ABCD1234");
    expect(page.getByRole("dialog").all()).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "Add computer" }));

    expect(state.connectPairing).toHaveBeenCalledOnce();
    await expect.element(page.getByText("Add the computer first.")).toBeVisible();
    expect(page.getByRole("dialog").all()).toHaveLength(1);
  });
});
