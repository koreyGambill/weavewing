import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import { openUseInAnotherApp } from "../../mcp/UseInAnotherAppDialog";
import { ServerUpdateAction, ServerUpdateProgress } from "../../ServerUpdateAction";
import { Button } from "../../ui/button";
import { MenuItem, Menu, MenuPopup, MenuTrigger } from "../../ui/menu";
import { EnvironmentIconMenu } from "../EnvironmentIconPicker";
import { EnvironmentRow } from "../EnvironmentRow";
import { accessSummary, ServerAccessDetail } from "./ServerAccessDetail";
import type { ReachModel } from "./reachModel.logic";
import type { ReachServer } from "./useReachModel";
import type { SquareChangeState } from "./useSquareChange";

/** The toggle under a server's name that opens its list of who has access. */
export function ServerAccessToggle({
  model,
  server,
  open,
  onOpenChange,
  note,
}: {
  readonly model: ReachModel;
  readonly server: ReachServer;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Who manages it, or how it is reached, when that is worth a line. */
  readonly note?: { readonly text: string; readonly tone: "success" | "warning" | "muted" } | null;
}) {
  const summary = accessSummary(model, server);
  return (
    <div className="mt-0.5 space-y-0.5">
      {note ? (
        <p
          className={cn(
            "text-xs",
            note.tone === "success"
              ? "text-success-foreground"
              : note.tone === "warning"
                ? "text-warning-foreground"
                : "text-muted-foreground",
          )}
        >
          {note.text}
        </p>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0", open && "rotate-90")} />
        {summary || "Access"}
      </button>
    </div>
  );
}

/** Menu entries every server row offers for its access. */
export function ServerAccessMenuItems({ server }: { readonly server: ReachServer }) {
  return (
    <MenuItem onClick={() => openUseInAnotherApp(server.input.environmentId)}>
      Use in another app (MCP)
    </MenuItem>
  );
}

/** A server this desktop runs itself: its primary or a WSL backend. */
export function LocalServerRow({
  model,
  server,
  change,
  isDefault,
}: {
  readonly model: ReachModel;
  readonly server: ReachServer;
  readonly change: SquareChangeState;
  readonly isDefault: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { environment } = server;
  const { environmentId, serverConfig } = environment;
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const mismatch = resolveServerConfigVersionMismatch(serverConfig);
  const connected = environment.connection.phase === "connected";
  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(serverConfig)}
      label={environment.label}
      subtitle={
        <span className="flex min-w-0 items-center gap-1.5">
          {isDefault ? (
            <span className="rounded-sm border border-border px-1 text-2xs">
              default for new threads
            </span>
          ) : null}
          <span className="truncate">
            {connected
              ? (serverConfig?.environment.serverVersion ?? "")
              : connectionStatusText(environment.connection)}
          </span>
        </span>
      }
      below={
        <>
          {updateState.status !== "idle" ? (
            <div className="mt-1 max-w-md">
              <ServerUpdateProgress state={updateState} />
            </div>
          ) : null}
          <ServerAccessToggle model={model} server={server} open={open} onOpenChange={setOpen} />
        </>
      }
      detail={open ? <ServerAccessDetail model={model} server={server} change={change} /> : null}
    >
      {mismatch && connected && updateState.status !== "running" ? (
        <ServerUpdateAction
          size="xs"
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          selfUpdate={resolveServerSelfUpdateCapability(serverConfig)}
          installation={serverConfig?.environment.capabilities.serverInstallation}
          desktopAppUpdate={supportsDesktopAppUpdate(serverConfig)}
          targetVersion={mismatch.clientVersion}
          label={updateState.status === "failed" ? "Retry update" : "Update"}
        />
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              aria-label={`More actions for ${environment.label}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <EnvironmentIconMenu environmentId={environmentId} serverConfig={serverConfig} />
          <ServerAccessMenuItems server={server} />
        </MenuPopup>
      </Menu>
    </EnvironmentRow>
  );
}
