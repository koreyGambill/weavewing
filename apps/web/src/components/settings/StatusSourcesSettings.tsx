import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { pendingRouteOrder } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, StatusSource, StatusSourceKind } from "@t3tools/contracts";
import { GripVerticalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  statusSources,
  statusSourcesDelete,
  statusSourcesReorder,
  statusSourcesRotateWebhookSecret,
  statusSourcesSnooze,
  statusSourcesUpsert,
} from "../../state/statusSources";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import {
  StatusStateIcon,
  StatusSourceIcon,
  STATUS_SOURCE_ICONS,
} from "../statusSources/StatusSourceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { APP_BASE_NAME } from "~/branding";

const KINDS = {
  "wing-status": "Wing status",
  "http-health": "HTTP health",
  command: "Local command",
  webhook: "Signed webhook",
} satisfies Record<StatusSourceKind, string>;

export function StatusSourcesSettings() {
  const { scope, environment } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsScopeNotice target="environment">
        Choose one environment to manage its status sources.
      </SettingsScopeNotice>
    );
  }
  if (
    environment.connection.phase !== "connected" ||
    environment.serverConfig?.environment.capabilities.statusSources !== true
  ) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Status sources">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect to an environment running a version of {APP_BASE_NAME} that supports status
            sources.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <EnvironmentStatusSources
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={environment.label}
      sharing={environment.serverConfig.environment.capabilities.statusSourceSharing === true}
      ordering={environment.serverConfig.environment.capabilities.statusSourceOrder === true}
    />
  );
}

function EnvironmentStatusSources({
  environmentId,
  label,
  sharing,
  ordering,
}: {
  environmentId: EnvironmentId;
  label: string;
  sharing: boolean;
  ordering: boolean;
}) {
  const query = useEnvironmentQuery(statusSources({ environmentId, input: {} }));
  const saved = query.data?.filter((source) => !source.origin);
  const savedIds = saved?.map((source) => source.config.id) ?? [];
  const [pendingOrder, setPendingOrder] = useState<ReadonlyArray<string> | null>(null);
  const shownOrder = pendingRouteOrder(pendingOrder, savedIds);
  // Dropped during render so a stale order never outlives the save it was for.
  if (pendingOrder !== null && shownOrder === null) setPendingOrder(null);
  const order: Array<string> = shownOrder === null ? savedIds : [...shownOrder];
  const byId = new Map(saved?.map((source) => [source.config.id, source]));
  const own = saved && order.flatMap((id) => byId.get(id) ?? []);
  const canEdit = useAtomValue(statusSourcesUpsert.permissionAtom(environmentId));
  const canReorder = ordering && canEdit && order.length > 1;
  const reorder = useAtomCommand(statusSourcesReorder, { reportFailure: true });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const next = arrayMove(
      order,
      order.indexOf(String(event.active.id)),
      order.indexOf(String(event.over.id)),
    );
    setPendingOrder(next);
    void reorder({ environmentId, input: { ids: next } }).then((result) => {
      if (result._tag === "Failure") setPendingOrder(null);
    });
  };
  const [editing, setEditing] = useState<StatusSource | "new" | null>(null);
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="status-sources"
        title="Status sources"
        headerAction={
          <Button size="xs" variant="outline" disabled={!canEdit} onClick={() => setEditing("new")}>
            <PlusIcon />
            Add source
          </Button>
        }
      >
        <p className="px-4 py-3 text-xs text-muted-foreground">
          External tools checked from {label}. See current state and the last transition in the
          Status tool in the right tools sidebar. History stays in each tool. Snoozing mutes
          notifications while checks continue.
          {sharing && ` Shared sources also alert on every machine that links to ${label}.`}
        </p>
        {!canEdit && (
          <p className="px-4 pb-3 text-xs text-muted-foreground">
            The operate permission is required to manage sources.
          </p>
        )}
        {query.error && (
          <p role="alert" className="px-4 py-3 text-sm text-destructive">
            {query.error}
          </p>
        )}
        {query.isPending && query.data === null && (
          <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
            Loading sources…
          </p>
        )}
        {own?.length === 0 && (
          <SettingsRow
            title="No status sources"
            description="Add a Wing status endpoint, health URL, local command, or signed webhook."
          />
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            {own?.map((source, index) => (
              <StatusSourceRow
                key={source.config.id}
                source={source}
                position={index + 1}
                environmentId={environmentId}
                canEdit={canEdit}
                canReorder={canReorder}
                onEdit={() => setEditing(source)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </SettingsSection>
      {editing !== null && (
        <StatusSourceEditor
          environmentId={environmentId}
          sharing={sharing}
          source={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsPageContainer>
  );
}

function StatusSourceRow({
  source,
  position,
  environmentId,
  canEdit,
  canReorder,
  onEdit,
}: {
  source: StatusSource;
  position: number;
  environmentId: EnvironmentId;
  canEdit: boolean;
  canReorder: boolean;
  onEdit: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: source.config.id, disabled: !canReorder });
  const remove = useAtomCommand(statusSourcesDelete, { reportFailure: true });
  const snooze = useAtomCommand(statusSourcesSnooze, { reportFailure: true });
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const now = useNowMinute();
  const snoozed = source.config.snoozedUntil !== null && source.config.snoozedUntil > now;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10 rounded-lg bg-background shadow-md")}
    >
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {canReorder && (
              <button
                type="button"
                ref={setActivatorNodeRef}
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${source.config.name}, position ${position}`}
                className="-ms-1.5 flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
              >
                <GripVerticalIcon className="size-3.5" />
              </button>
            )}
            <StatusSourceIcon source={source} />
            {source.config.name}
            <StatusStateIcon state={source.latest.state} />
          </span>
        }
        description={
          <span>
            {source.latest.summary}
            {snoozed && (
              <span className="block">
                Snoozed until {new Date(source.config.snoozedUntil!).toLocaleString()}
              </span>
            )}
          </span>
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={!canEdit || pending}
              onClick={async () => {
                const choice = snoozed
                  ? null
                  : await requestCustomSnooze({
                      title: `Snooze ${source.config.name}`,
                      description:
                        "Choose when notifications for this source resume. Status checks continue while snoozed.",
                    });
                if (!snoozed && choice === null) return;
                setPending(true);
                await snooze({
                  environmentId,
                  input: {
                    id: source.config.id,
                    until: choice?.snoozedUntil ?? null,
                  },
                });
                setPending(false);
              }}
            >
              {snoozed ? "Unsnooze" : "Snooze…"}
            </Button>
            <Button size="xs" variant="ghost" disabled={!canEdit} onClick={onEdit}>
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={!canEdit}
              onClick={() => setRemoving(true)}
            >
              Remove
            </Button>
          </div>
        }
      />
      {removing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(false);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Remove {source.config.name}?</DialogTitle>
              <DialogDescription>Checks and notifications stop for this source.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoving(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  const result = await remove({ environmentId, input: { id: source.config.id } });
                  setPending(false);
                  if (result._tag === "Success") setRemoving(false);
                }}
              >
                Remove source
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}

function parseHeaders(value: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((entry) => typeof entry !== "string")
    )
      return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

function StatusSourceEditor({
  environmentId,
  sharing,
  source,
  onClose,
}: {
  environmentId: EnvironmentId;
  sharing: boolean;
  source: StatusSource | undefined;
  onClose: () => void;
}) {
  const save = useAtomCommand(statusSourcesUpsert, { reportFailure: true });
  const rotate = useAtomCommand(statusSourcesRotateWebhookSecret, { reportFailure: true });
  const canEdit = useAtomValue(statusSourcesUpsert.permissionAtom(environmentId));
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [name, setName] = useState(source?.config.name ?? "");
  const [kind, setKind] = useState<StatusSourceKind>(source?.config.kind ?? "wing-status");
  const [icon, setIcon] = useState(source?.config.icon ?? "activity");
  const [target, setTarget] = useState("");
  const [headers, setHeaders] = useState("");
  const [interval, setInterval] = useState(source?.config.intervalSeconds ?? 60);
  const [timeout, setTimeout] = useState(source?.config.timeoutSeconds ?? 10);
  const [shared, setShared] = useState(source?.config.shared ?? true);
  const [pending, setPending] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(source?.config.id);
  const [error, setError] = useState<string | null>(null);
  const isHttp = kind === "wing-status" || kind === "http-health";
  const submit = async () => {
    const parsedHeaders = headers.trim() ? parseHeaders(headers) : undefined;
    if (!name.trim() || (!source && kind !== "webhook" && !target.trim())) {
      setError("Enter a name and a URL or command.");
      return;
    }
    if (parsedHeaders === null) {
      setError("Headers must be a JSON object with string values.");
      return;
    }
    if (
      !Number.isInteger(interval) ||
      interval < 30 ||
      interval > 86400 ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 60
    ) {
      setError("Use an interval of 30–86400 seconds and a timeout of 1–60 seconds.");
      return;
    }
    setError(null);
    setPending(true);
    const result = await save({
      environmentId,
      input: {
        ...(savedId ? { id: savedId } : {}),
        name: name.trim(),
        kind,
        icon,
        intervalSeconds: interval,
        timeoutSeconds: timeout,
        // Left out when unchanged, so an older open dialog cannot undo another device's choice.
        ...(shared !== (source?.config.shared ?? true) ? { shared } : {}),
        ...(target.trim() ? { target: target.trim() } : {}),
        ...(parsedHeaders === undefined || parsedHeaders === null
          ? {}
          : { headers: parsedHeaders }),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      if (kind === "webhook" && !savedId) setSavedId(result.value.config.id);
      else onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{source ? "Edit status source" : "Add status source"}</DialogTitle>
          <DialogDescription>
            Checks run on the selected environment. URLs and commands must be reachable from that
            machine.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="status-source-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pending && canEdit) void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="status-source-name">Name</Label>
              <Input
                id="status-source-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
                disabled={!canEdit}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status-source-kind">Source type</Label>
              <Select
                value={kind}
                disabled={!!savedId || !canEdit}
                onValueChange={(value) => {
                  if (value && value in KINDS) setKind(value as StatusSourceKind);
                }}
              >
                <SelectTrigger id="status-source-kind">
                  <SelectValue>{KINDS[kind]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(KINDS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status-source-icon">Icon</Label>
              <Select
                value={icon}
                disabled={!canEdit}
                onValueChange={(value) => {
                  if (value) setIcon(value);
                }}
              >
                <SelectTrigger id="status-source-icon">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {Object.entries(STATUS_SOURCE_ICONS).map(([value, Icon]) => (
                    <SelectItem key={value} value={value}>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4" />
                        {value}
                      </span>
                    </SelectItem>
                  ))}
                  <SelectItem value="favicon">Site favicon</SelectItem>
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">
                The site favicon is available for URL sources.
              </p>
            </div>
            {kind !== "webhook" && (
              <div className="grid gap-1.5">
                <Label htmlFor="status-source-target">
                  {kind === "command" ? "Command" : "URL"}
                </Label>
                <Input
                  id="status-source-target"
                  type="text"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder={
                    source
                      ? "Leave blank to keep the saved value"
                      : kind === "command"
                        ? "my-check --json"
                        : "http://127.0.0.1:4791/api/status"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canEdit}
                />
                {source && (
                  <p className="break-all text-xs text-muted-foreground">
                    {source.config.target || "Saved command"}. Leave blank to keep the saved value
                    and credentials.
                  </p>
                )}
                {kind === "command" && (
                  <p className="text-xs text-muted-foreground">
                    Runs a local command on the server. JSON status output is optional. Exit code 0
                    means OK.
                  </p>
                )}
              </div>
            )}
            {isHttp && (
              <div className="grid gap-1.5">
                <Label htmlFor="status-source-headers">Request headers (JSON, optional)</Label>
                <Textarea
                  id="status-source-headers"
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                  placeholder={
                    source?.config.hasCredentials
                      ? "Leave blank to keep saved headers"
                      : '{"Authorization":"Bearer …"}'
                  }
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canEdit}
                />
                <p className="text-xs text-muted-foreground">
                  Credentials are stored on the server. Enter {"{}"} to clear saved headers.
                </p>
              </div>
            )}
            {kind !== "webhook" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="status-source-interval">Interval (seconds)</Label>
                  <Input
                    id="status-source-interval"
                    type="number"
                    value={interval}
                    min={30}
                    max={86400}
                    step={1}
                    onChange={(event) => setInterval(Number(event.target.value))}
                    disabled={!canEdit}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="status-source-timeout">Timeout (seconds)</Label>
                  <Input
                    id="status-source-timeout"
                    type="number"
                    value={timeout}
                    min={1}
                    max={60}
                    step={1}
                    onChange={(event) => setTimeout(Number(event.target.value))}
                    disabled={!canEdit}
                  />
                </div>
              </div>
            )}
            {kind === "webhook" && (
              <div className="space-y-2 text-xs text-muted-foreground">
                <p>Save the source, then generate its signing secret to configure the sender.</p>
                <p>
                  Send Wing status JSON with an updatedAt timestamp and an x-t3-signature header
                  containing sha256= followed by the HMAC-SHA256 of the exact body bytes, signed
                  with this secret.
                </p>
                {savedId && (
                  <>
                    <p className="break-all">
                      Endpoint: {baseUrl?.replace(/\/$/, "")}/api/status-sources/{savedId}/webhook
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canEdit || pending}
                      onClick={async () => {
                        setPending(true);
                        const result = await rotate({ environmentId, input: { id: savedId } });
                        setPending(false);
                        if (result._tag === "Success") setSecret(result.value.secret);
                      }}
                    >
                      {secret ? "Replace signing secret" : "Generate signing secret"}
                    </Button>
                    {secret && (
                      <div className="grid gap-1.5">
                        <Label htmlFor="status-source-secret">
                          Copy this secret before closing
                        </Label>
                        <Input
                          id="status-source-secret"
                          value={secret}
                          readOnly
                          autoComplete="off"
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {sharing && (
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-1">
                  <Label htmlFor="status-source-shared">Share with linked machines</Label>
                  <p className="text-xs text-muted-foreground">
                    Machines that link to this one show this source and alert when it fails.
                  </p>
                </div>
                <Switch
                  id="status-source-shared"
                  checked={shared}
                  onCheckedChange={setShared}
                  disabled={!canEdit}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            {secret ? "Done" : "Cancel"}
          </Button>
          <Button form="status-source-form" type="submit" disabled={pending || !canEdit}>
            {pending ? "Saving…" : savedId ? "Save changes" : "Add source"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
