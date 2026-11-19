import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type AuthGrantScope,
  type AuthPairingCredentialResult,
  type EnvironmentId,
  managedCapabilityDenial,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { PlusIcon } from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { authEnvironment } from "~/state/auth";
import type { EnvironmentPresentation } from "~/state/environments";
import { useManagedPolicy } from "~/state/managedPolicy";
import { readEnvironmentScope, useEnvironmentSessionState } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useUiStateStore } from "~/uiStateStore";
import { ManagedControl } from "../../ManagedPolicy";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Dialog, DialogTrigger } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../../ui/wizard";
import { AddComputerFields } from "../AddComputerFields";
import { SettingsSearchTarget } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { PairingClientsList } from "../AuthorizedClientsSettings";
import { isQrShareableEndpoint, togglePairingScopeSelection } from "../ConnectionsSettings.logic";
import { isLoopbackHostname } from "~/environments/primary";
import { type DeviceLevel, deviceScopes, joinsTrusted, planConnect } from "./connectPlan.logic";
import {
  LINK_LEVEL_CHOICES,
  type LinkLevelChoice,
  REACH_LEVEL_LABELS,
  type ReachModel,
  type ReachParty,
  serverPartyId,
} from "./reachModel.logic";
import {
  CLOSED,
  CONNECT_COMPUTER_HASH,
  type How,
  type Kind,
  openConnectWizard,
  useWizardStore,
  type WizardState,
} from "./connectWizardStore";
import { usePairingEndpoints } from "./ServerAccessDetail";
import type { ReachServer } from "./useReachModel";
import type { SquareChangeState } from "./useSquareChange";

const HOW_CHOICES: Record<Kind, ReadonlyArray<{ value: How; title: string; detail: string }>> = {
  device: [
    { value: "qr", title: "QR code", detail: "Scan this screen." },
    { value: "link", title: "Link", detail: "Copy a link to open on the device." },
  ],
  computer: [
    { value: "address", title: "Link or address", detail: "Type its address and a code from it." },
    { value: "ssh", title: "SSH", detail: "You can already ssh in. No code needed." },
  ],
};

function Tiles<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T | null;
  readonly options: ReadonlyArray<{ value: T; title: string; detail: string }>;
  readonly onChange: (next: T) => void;
}) {
  return (
    <RadioGroup
      aria-label={label}
      value={value ?? ""}
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);
        if (picked) onChange(picked.value);
      }}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm has-data-checked:border-primary"
        >
          <Radio value={option.value} className="mt-0.5" />
          <span>
            <span className="block font-medium">{option.title}</span>
            <span className="block text-xs text-muted-foreground">{option.detail}</span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}

/**
 * The one way to hand out access and to add a computer: "+ Connect a device or computer". A
 * device gets a pairing link on one server; a computer is added here, then linked both ways.
 */
export function ConnectWizard({
  model,
  servers,
  change,
}: {
  readonly model: ReachModel;
  readonly servers: ReadonlyArray<ReachServer>;
  readonly change: SquareChangeState;
}) {
  const { open, step, kind, how } = useWizardStore();
  const set = (next: Partial<WizardState>) => useWizardStore.setState(next);
  const hash = useLocation({ select: (location) => location.hash });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a link from elsewhere asks for the wizard through the URL
  useEffect(() => {
    if (hash === CONNECT_COMPUTER_HASH) openConnectWizard("computer");
  }, [hash]);
  const canSsh = window.desktopBridge !== undefined;
  const howChoices =
    kind === null ? [] : HOW_CHOICES[kind].filter((c) => c.value !== "ssh" || canSsh);
  const ready = step === 0 ? kind !== null : step === 1 ? how !== null : true;
  const saved = servers
    .map((server) => server.environment)
    .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget");
  const [adding, setAdding] = useState(false);
  // On a computer's How step, Next submits its fields, so Access opens only with one added.
  const addsComputer = step === 1 && kind === "computer" && (how === "address" || how === "ssh");
  const hasComputer = otherComputers(servers).length > 0;

  return (
    <SettingsSearchTarget {...searchableSetting("connect")} className="px-3 sm:px-4">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) set({ open: true });
          else useWizardStore.setState(CLOSED);
          // An add cut short by closing never reports back, so it cannot stay busy.
          setAdding(false);
        }}
      >
        <DialogTrigger
          render={
            <Button size="sm" variant="default">
              <PlusIcon className="size-3.5" />
              Connect a device or computer
            </Button>
          }
        />
        <WizardPopup>
          <WizardHeader title="Connect a device or computer">
            <WizardSteps
              steps={["What", "How", "Access"]}
              currentStep={step}
              onStepChange={(next) => set({ step: next })}
              isStepDisabled={(index) => index > step}
            />
          </WizardHeader>
          <WizardPanel>
            {step === 0 ? (
              <Tiles<Kind>
                label="What are you connecting?"
                value={kind}
                onChange={(next) =>
                  set({ kind: next, how: next === "computer" ? "address" : null })
                }
                options={[
                  {
                    value: "device",
                    title: "A phone, tablet or browser",
                    detail: "Controls your computers.",
                  },
                  {
                    value: "computer",
                    title: "Another computer",
                    detail: "Runs agents too. Access can go both ways.",
                  },
                ]}
              />
            ) : step === 1 ? (
              <div className="space-y-3">
                <Tiles<How>
                  label="How will it get here?"
                  value={how}
                  onChange={(next) => {
                    set({ how: next });
                    setAdding(false);
                  }}
                  options={howChoices}
                />
                {kind === "computer" && (how === "address" || how === "ssh") ? (
                  <div className="space-y-2 border-t border-border pt-3">
                    <AddComputerFields
                      key={how}
                      mode={how === "ssh" ? "ssh" : "remote"}
                      routeTarget={null}
                      savedEnvironments={saved}
                      formId={ADD_COMPUTER_FORM_ID}
                      onAdded={() => set({ step: 2 })}
                      onSubmitEmpty={() => {
                        if (hasComputer) set({ step: 2 });
                        return hasComputer;
                      }}
                      onBusyChange={setAdding}
                    />
                    {hasComputer ? (
                      <p className="text-xs text-muted-foreground">
                        Already added it? Leave the fields empty and press Next.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : kind === "device" ? (
              <PairDeviceForm servers={servers} qr={how === "qr"} />
            ) : (
              <ConnectComputerForm
                model={model}
                servers={servers}
                change={change}
                onBack={() => set({ step: 1 })}
              />
            )}
          </WizardPanel>
          <WizardFooter
            leading={
              step > 0 ? (
                <Button variant="ghost" onClick={() => set({ step: step - 1 })}>
                  Back
                </Button>
              ) : null
            }
          >
            {addsComputer ? (
              <Button type="submit" form={ADD_COMPUTER_FORM_ID} disabled={adding}>
                {adding ? "Adding…" : "Next"}
              </Button>
            ) : step < 2 ? (
              <Button disabled={!ready} onClick={() => set({ step: step + 1 })}>
                Next
              </Button>
            ) : (
              <Button variant="outline" onClick={() => useWizardStore.setState(CLOSED)}>
                Done
              </Button>
            )}
          </WizardFooter>
        </WizardPopup>
      </Dialog>
    </SettingsSearchTarget>
  );
}

const ADD_COMPUTER_FORM_ID = "connect-wizard-add-computer";

// Saved computers this app could link, newest last; never the page's own server or this desktop's.
const otherComputers = (servers: ReadonlyArray<ReachServer>) =>
  servers.filter(
    (server) =>
      !server.input.onThisComputer &&
      server.environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

// The server that served this app comes first, as the likeliest one to pair with.
const pairingTarget = (servers: ReadonlyArray<ReachServer>) =>
  servers
    .filter((server) => server.input.canManage)
    .toSorted(
      (left, right) =>
        Number(right.environment.entry.target._tag === "PrimaryConnectionTarget") -
        Number(left.environment.entry.target._tag === "PrimaryConnectionTarget"),
    );

/** A pairing link on one server for a named device, at View only or Full access. */
export function PairDeviceForm({
  servers,
  qr,
}: {
  readonly servers: ReadonlyArray<ReachServer>;
  readonly qr: boolean;
}) {
  const candidates = pairingTarget(servers);
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const server =
    candidates.find((candidate) => candidate.input.environmentId === chosen) ??
    candidates[0] ??
    null;
  if (server === null) {
    return (
      <p className="text-sm text-muted-foreground">
        This app cannot hand out access on any server. Pair from a device with full access to one.
      </p>
    );
  }
  return (
    <PairDeviceFields
      key={server.input.environmentId}
      server={server}
      candidates={candidates}
      qr={qr}
      onServerChange={setChosen}
    />
  );
}

function PairDeviceFields({
  server,
  candidates,
  qr,
  onServerChange,
}: {
  readonly server: ReachServer;
  readonly candidates: ReadonlyArray<ReachServer>;
  readonly qr: boolean;
  readonly onServerChange: (environmentId: EnvironmentId) => void;
}) {
  const environmentId = server.input.environmentId;
  const session = useEnvironmentSessionState(environmentId);
  const delegatable = session.data?.authenticated
    ? (session.data.permissions ?? session.data.scopes ?? [])
    : [];
  const denial = managedCapabilityDenial(useManagedPolicy(environmentId), "remoteClients");
  const createPairingCredential = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  const revokePairingLink = useAtomCommand(authEnvironment.revokePairingLink);
  const [revoking, setRevoking] = useState(false);
  const endpoints = usePairingEndpoints(server);
  // A page served by this server can share its own address unless that is loopback.
  const servedHere =
    server.environment.entry.target._tag === "PrimaryConnectionTarget" &&
    !isLoopbackHostname(window.location.hostname);
  const noShareableAddress = !servedHere && !endpoints.some(isQrShareableEndpoint);
  const noAddressNote = noShareableAddress ? (
    <p className="text-xs text-warning-foreground">
      {server.input.label} has no address another device can reach, so there is no QR code or link
      to open. The device types the code instead, at an address it can reach.
    </p>
  ) : null;
  const defaultEndpointKey = useUiStateStore((state) => state.defaultAdvertisedEndpointKey);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<DeviceLevel>("full-access");
  const [custom, setCustom] = useState<ReadonlyArray<AuthGrantScope> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<
    (AuthPairingCredentialResult & { readonly createdAt: string }) | null
  >(null);
  const scopes = custom ?? deviceScopes(level, delegatable);

  const create = async () => {
    if (scopes.length === 0 || !readEnvironmentScope(environmentId, AuthAccessWriteScope)) return;
    setBusy(true);
    setError(null);
    const trimmed = name.trim();
    const result = await createPairingCredential({
      environmentId,
      input: { ...(trimmed ? { label: trimmed } : {}), scopes },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setCreated({ ...result.value, createdAt: new Date().toISOString() });
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  if (created !== null) {
    return (
      <div className="space-y-3">
        {noAddressNote}
        <div className="-mx-6 border-y border-border/60">
          <PairingClientsList
            servedByEnvironment={server.environment.entry.target._tag === "PrimaryConnectionTarget"}
            endpointUrl={null}
            endpoints={endpoints}
            defaultEndpointKey={defaultEndpointKey}
            pairingLinks={[
              {
                id: created.id,
                scopes,
                subject: "",
                ...(created.label ? { label: created.label } : {}),
                createdAt: created.createdAt,
                expiresAt: DateTime.formatIso(created.expiresAt),
              },
            ]}
            createdPairingCredentials={new Map([[created.id, created.credential]])}
            sharedPairingLinkId={qr ? created.id : null}
            revokingPairingLinkId={revoking ? created.id : null}
            onRevokePairingLink={(id) => {
              setRevoking(true);
              void revokePairingLink({ environmentId, input: { id } }).then((result) => {
                setRevoking(false);
                if (result._tag === "Success") setCreated(null);
              });
            }}
            canRevoke
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <label className="block space-y-1.5">
        <span className="block text-xs font-medium">It may use</span>
        <ServerSelect
          servers={candidates.map((candidate) => ({
            environmentId: candidate.input.environmentId,
            label: candidate.input.label,
          }))}
          value={environmentId}
          onChange={onServerChange}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="block text-xs font-medium">Name</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Korey iPhone"
          disabled={busy}
          nativeInput
        />
      </label>
      <div className="space-y-1.5">
        <span className="block text-xs font-medium">Level</span>
        <RadioGroup
          aria-label="Level"
          value={custom === null ? level : ""}
          onValueChange={(next) => {
            if (next === "read-only" || next === "full-access") {
              setLevel(next);
              setCustom(null);
            }
          }}
        >
          {(["read-only", "full-access"] as const).map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <Radio value={option} />
              {REACH_LEVEL_LABELS[option]}
            </label>
          ))}
        </RadioGroup>
        <Collapsible>
          <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Custom permissions
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-2 divide-y divide-border/60 rounded-lg border border-input">
              {AUTH_SCOPE_OPTIONS.filter(({ scope }) => delegatable.includes(scope)).map(
                ({ scope, title }) => (
                  <label key={scope} className="flex items-center gap-2.5 px-3 py-1.5 text-xs">
                    <Checkbox
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) =>
                        setCustom(togglePairingScopeSelection(scopes, scope, checked === true))
                      }
                    />
                    {title}
                  </label>
                ),
              )}
            </div>
          </CollapsiblePanel>
        </Collapsible>
        {scopes.includes(AuthAccessWriteScope) ? (
          <p className="text-xs text-warning-foreground">
            It can hand out and take away access to {server.input.label} too.
          </p>
        ) : null}
      </div>
      {qr ? noAddressNote : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {denial !== undefined ? (
        <ManagedControl reason={denial}>
          <Button disabled>Create {qr ? "QR code" : "link"}</Button>
        </ManagedControl>
      ) : (
        <Button disabled={busy || scopes.length === 0} onClick={() => void create()}>
          {busy ? "Creating…" : `Create ${qr ? "QR code" : "link"}`}
        </Button>
      )}
    </div>
  );
}

function ServerSelect({
  servers,
  value,
  onChange,
  label = "Server",
}: {
  readonly servers: ReadonlyArray<Pick<EnvironmentPresentation, "environmentId" | "label">>;
  readonly value: EnvironmentId | null;
  readonly onChange: (environmentId: EnvironmentId) => void;
  readonly label?: string;
}) {
  return (
    <Select
      value={value ?? ""}
      onValueChange={(next) => {
        const picked = servers.find((server) => server.environmentId === next);
        if (picked) onChange(picked.environmentId);
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>
          {(current: string) =>
            servers.find((server) => server.environmentId === current)?.label ?? "Pick one"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {servers.map((server) => (
          <SelectItem hideIndicator key={server.environmentId} value={server.environmentId}>
            {server.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function LevelSelect({
  value,
  onChange,
  label,
}: {
  readonly value: LinkLevelChoice;
  readonly onChange: (next: LinkLevelChoice) => void;
  readonly label: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const picked = LINK_LEVEL_CHOICES.find((option) => option === next);
        if (picked) onChange(picked);
      }}
    >
      <SelectTrigger size="sm" className="w-44" aria-label={label}>
        <SelectValue>{REACH_LEVEL_LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {LINK_LEVEL_CHOICES.map((option) => (
          <SelectItem hideIndicator key={option} value={option}>
            {REACH_LEVEL_LABELS[option]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ServerChecks({
  servers,
  selected,
  onChange,
}: {
  readonly servers: ReadonlyArray<ReachParty>;
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
}) {
  return (
    <span className="flex flex-wrap gap-3">
      {servers.map((server) => (
        <label key={server.id} className="flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={selected.has(server.id)}
            onCheckedChange={(checked) => {
              const next = new Set(selected);
              if (checked === true) next.add(server.id);
              else next.delete(server.id);
              onChange(next);
            }}
          />
          {server.label}
        </label>
      ))}
    </span>
  );
}

/** Links a computer this app already reaches with the other servers, in both directions. */
function ConnectComputerForm({
  model,
  servers,
  change,
  onBack,
}: {
  readonly model: ReachModel;
  readonly servers: ReadonlyArray<ReachServer>;
  readonly change: SquareChangeState;
  readonly onBack: () => void;
}) {
  const [computerId, setComputerId] = useState<EnvironmentId | null>(
    // The computer just added is the last one saved.
    otherComputers(servers).at(-1)?.input.environmentId ?? null,
  );
  const computer =
    computerId === null
      ? null
      : (model.columns.find((column) => column.id === serverPartyId(computerId)) ?? null);
  // Servers this app is not connected to cannot be linked from here.
  const connected = model.columns.filter((column) => !model.unconnected.has(column.id));
  const others = connected.filter((column) => column.id !== computer?.id);
  const [uses, setUses] = useState<ReadonlySet<string>>(() => new Set(others.map((o) => o.id)));
  const [usedBy, setUsedBy] = useState<ReadonlySet<string>>(() => new Set(others.map((o) => o.id)));
  const [usesLevel, setUsesLevel] = useState<LinkLevelChoice>("full-access");
  const [usedByLevel, setUsedByLevel] = useState<LinkLevelChoice>("full-access");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReadonlyMap<string, string | null>>(new Map());
  if (computer === null) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>No computer is added yet.</span>
        <Button size="sm" variant="outline" onClick={onBack}>
          Add one
        </Button>
      </div>
    );
  }
  const choice = {
    uses: others.filter((other) => uses.has(other.id)),
    usesLevel,
    usedBy: others.filter((other) => usedBy.has(other.id)),
    usedByLevel,
  };
  const lines = planConnect(model, computer, choice);
  const runnable = lines.filter((line) => line.blocked === null);
  const connect = async () => {
    setRunning(true);
    const next = new Map<string, string | null>();
    for (const line of runnable) {
      next.set(
        line.square.from.id + line.square.to.id,
        await change.applyNow(line.square, line.target),
      );
      setResults(new Map(next));
    }
    setRunning(false);
  };
  return (
    <div className="space-y-4">
      <label className="block space-y-1.5">
        <span className="block text-xs font-medium">Computer</span>
        <ServerSelect
          label="Computer"
          servers={connected.flatMap((column) =>
            column.environmentId === null
              ? []
              : [{ environmentId: column.environmentId, label: column.label }],
          )}
          value={computerId}
          onChange={(next) => {
            setComputerId(next);
            setResults(new Map());
          }}
        />
      </label>
      <div className="space-y-1.5">
        <span className="block text-xs font-medium">{computer.label} may use</span>
        <div className="flex flex-wrap items-center gap-3">
          <ServerChecks servers={others} selected={uses} onChange={setUses} />
          <LevelSelect value={usesLevel} onChange={setUsesLevel} label="Level it may use them at" />
        </div>
      </div>
      <div className="space-y-1.5">
        <span className="block text-xs font-medium">May use {computer.label}</span>
        <div className="flex flex-wrap items-center gap-3">
          <ServerChecks servers={others} selected={usedBy} onChange={setUsedBy} />
          <LevelSelect
            value={usedByLevel}
            onChange={setUsedByLevel}
            label="Level they may use it at"
          />
        </div>
      </div>
      <ul className="space-y-1 text-xs">
        {lines.length === 0 ? (
          <li className="text-muted-foreground">Nothing to change.</li>
        ) : (
          lines.map((line) => {
            const key = line.square.from.id + line.square.to.id;
            const outcome = results.get(key);
            return (
              <li key={key}>
                From {line.square.from.label} to {line.square.to.label}:{" "}
                {REACH_LEVEL_LABELS[line.target]}
                <span
                  className={
                    line.blocked !== null || (outcome ?? null) !== null
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {line.blocked !== null
                    ? ` · ${line.blocked}`
                    : outcome === undefined
                      ? ""
                      : outcome === null
                        ? " · done"
                        : ` · ${outcome}`}
                </span>
              </li>
            );
          })
        )}
      </ul>
      {joinsTrusted(choice, lines) ? (
        <p className="text-xs text-success-foreground">
          Full access both ways, so {computer.label} joins Trusted together.
        </p>
      ) : null}
      <Button disabled={running || runnable.length === 0} onClick={() => void connect()}>
        {running ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}
