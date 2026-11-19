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
import { useState } from "react";

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
import { AddEnvironmentDialog } from "../AddEnvironmentDialog";
import { PairingClientsList } from "../AuthorizedClientsSettings";
import { togglePairingScopeSelection } from "../ConnectionsSettings.logic";
import { type DeviceLevel, deviceScopes, joinsTrusted, planConnect } from "./connectPlan.logic";
import {
  LINK_LEVEL_CHOICES,
  type LinkLevelChoice,
  REACH_LEVEL_LABELS,
  type ReachModel,
  type ReachParty,
  serverPartyId,
} from "./reachModel.logic";
import { usePairingEndpoints } from "./ServerAccessDetail";
import type { ReachServer } from "./useReachModel";
import type { SquareChangeState } from "./useSquareChange";

type Kind = "device" | "computer";
type How = "qr" | "link" | "address" | "ssh";

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
 * The one way to hand out access: "+ Connect a device or computer". A device gets a pairing
 * link on one server; a computer is added to this app, then linked both ways.
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
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Kind | null>(null);
  const [how, setHow] = useState<How | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const reset = () => {
    setStep(0);
    setKind(null);
    setHow(null);
  };
  const canSsh = window.desktopBridge !== undefined;
  const howChoices =
    kind === null ? [] : HOW_CHOICES[kind].filter((c) => c.value !== "ssh" || canSsh);
  const ready = step === 0 ? kind !== null : step === 1 ? how !== null : true;
  const saved = servers
    .map((server) => server.environment)
    .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget");

  return (
    <div id="connect" className="px-3 sm:px-4">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
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
              onStepChange={setStep}
              isStepDisabled={(index) => index > step}
            />
          </WizardHeader>
          <WizardPanel>
            {step === 0 ? (
              <Tiles<Kind>
                label="What are you connecting?"
                value={kind}
                onChange={(next) => {
                  setKind(next);
                  setHow(null);
                }}
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
                  onChange={setHow}
                  options={howChoices}
                />
                {kind === "computer" && (how === "address" || how === "ssh") ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                      {how === "ssh" ? "Add over SSH…" : "Add by address…"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Already added? Go on to Access.
                    </span>
                  </div>
                ) : null}
              </div>
            ) : kind === "device" ? (
              <PairDeviceForm servers={servers} qr={how === "qr"} />
            ) : (
              <ConnectComputerForm model={model} servers={servers} change={change} />
            )}
          </WizardPanel>
          <WizardFooter
            leading={
              step > 0 ? (
                <Button variant="ghost" onClick={() => setStep(step - 1)}>
                  Back
                </Button>
              ) : null
            }
          >
            {step < 2 ? (
              <Button disabled={!ready} onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)}>
                Done
              </Button>
            )}
          </WizardFooter>
        </WizardPopup>
      </Dialog>
      {kind === "computer" ? (
        <AddEnvironmentDialog
          key={how ?? "address"}
          open={addOpen}
          routeTarget={null}
          error={addError}
          savedEnvironments={saved}
          initialMode={how === "ssh" ? "ssh" : "remote"}
          showTrigger={false}
          onOpenChange={(next) => {
            setAddOpen(next);
            if (!next) setAddError(null);
          }}
          onErrorChange={setAddError}
        />
      ) : null}
    </div>
  );
}

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
    );
  }

  return (
    <div className="space-y-4">
      <label className="block space-y-1.5">
        <span className="block text-xs font-medium">It may use</span>
        <ServerSelect
          servers={candidates.map((candidate) => candidate.environment)}
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
  readonly servers: ReadonlyArray<EnvironmentPresentation>;
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
}: {
  readonly model: ReachModel;
  readonly servers: ReadonlyArray<ReachServer>;
  readonly change: SquareChangeState;
}) {
  const environments = servers.map((server) => server.environment);
  const [computerId, setComputerId] = useState<EnvironmentId | null>(
    servers.find((server) => !server.input.onThisComputer)?.input.environmentId ?? null,
  );
  const computer =
    computerId === null
      ? null
      : (model.columns.find((column) => column.id === serverPartyId(computerId)) ?? null);
  const others = model.columns.filter((column) => column.id !== computer?.id);
  const [uses, setUses] = useState<ReadonlySet<string>>(() => new Set(others.map((o) => o.id)));
  const [usedBy, setUsedBy] = useState<ReadonlySet<string>>(() => new Set(others.map((o) => o.id)));
  const [usesLevel, setUsesLevel] = useState<LinkLevelChoice>("full-access");
  const [usedByLevel, setUsedByLevel] = useState<LinkLevelChoice>("full-access");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ReadonlyMap<string, string | null>>(new Map());
  if (computer === null) {
    return <p className="text-sm text-muted-foreground">Add the computer first.</p>;
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
          servers={environments}
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
      {joinsTrusted(choice) ? (
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
