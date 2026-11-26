import { AuthEnvironmentMaintainScope, type DesktopWslState } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { desktopWslStateAtom, refreshDesktopWslState } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { applyWslEnableSelection, isWslSettingsRowVisible } from "../ConnectionsSettings.logic";
import { SettingsRow } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { APP_BASE_NAME } from "~/branding";

// Colons are invalid in distro names, keeping picker sentinels collision-free.
const BACKEND_VALUE_DEFAULT_WSL = "backend:default-wsl";
const BACKEND_VALUE_WSL_OFF = "backend:wsl-off";

type PendingWslChange =
  | { readonly kind: "disable"; readonly wasWslOnly: boolean }
  | { readonly kind: "distro"; readonly nextDistro: string | null }
  | { readonly kind: "enable"; readonly nextDistro: string | null }
  | { readonly kind: "wsl-only"; readonly nextValue: boolean };

/** Which WSL server this desktop runs beside Windows. Only for a desktop that manages its own. */
export function WslBackendSettings({
  canManageLocalBackend,
}: {
  readonly canManageLocalBackend: boolean;
}) {
  const desktopBridge = window.desktopBridge;
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopWsl = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? desktopWslStateAtom : null,
  );
  const [isUpdatingWslBackend, setIsUpdatingWslBackend] = useState(false);
  const [desktopWslMutationError, setDesktopWslMutationError] = useState<string | null>(null);
  const [pendingWslChange, setPendingWslChange] = useState<PendingWslChange | null>(null);
  const isWslConfirmDialogOpen = pendingWslChange !== null;
  const desktopWslState = desktopWsl.data;
  const desktopWslError = desktopWslMutationError ?? desktopWsl.error;
  const isLoadingWslState = desktopWsl.isPending && desktopWsl.data === null;

  const applyWslSettingChange = async (apply: () => Promise<DesktopWslState>) => {
    if (
      !desktopBridge ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope)
    )
      return;
    setIsUpdatingWslBackend(true);
    setDesktopWslMutationError(null);
    const settled = await settlePromise(async () => {
      await apply();
      refreshDesktopWslState();
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message = error instanceof Error ? error.message : "Failed to update WSL backend.";
      setDesktopWslMutationError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change WSL backend",
          description: message,
        }),
      );
      refreshDesktopWslState();
    }
    setIsUpdatingWslBackend(false);
  };

  const loadWslState = () => {
    setDesktopWslMutationError(null);
    refreshDesktopWslState();
  };

  const hasWslRegistrationToLose = environments.some((environment) =>
    isDesktopLocalConnectionTarget(environment.entry.target),
  );

  const handleSelectWslMode = (value: string) => {
    if (!desktopBridge || !desktopWslState) return;
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    if (value === BACKEND_VALUE_WSL_OFF) {
      // Unavailable WSL can remain wslOnly while disabled; switching to Windows must clear both.
      if (!desktopWslState.enabled && !desktopWslState.wslOnly) return;
      const wasWslOnly = desktopWslState.wslOnly;
      if (hasWslRegistrationToLose || wasWslOnly) {
        setPendingWslChange({ kind: "disable", wasWslOnly });
        return;
      }
      void applyWslSettingChange(() => desktopBridge.setWslBackendEnabled(false));
      return;
    }
    const nextDistro = value === BACKEND_VALUE_DEFAULT_WSL ? null : value;
    const resolvedNext = nextDistro ?? defaultDistroName;
    if (!desktopWslState.enabled) {
      setPendingWslChange({ kind: "enable", nextDistro });
      return;
    }
    const resolvedCurrent = desktopWslState.distro ?? defaultDistroName;
    if (resolvedCurrent === resolvedNext) return;
    if (hasWslRegistrationToLose || desktopWslState.wslOnly) {
      setPendingWslChange({ kind: "distro", nextDistro });
      return;
    }
    void applyWslSettingChange(() => desktopBridge.setWslDistro(nextDistro));
  };

  const handleConfirmEnableWsl = (mode: "both" | "wsl-only") => {
    if (!desktopBridge || !pendingWslChange || pendingWslChange.kind !== "enable") return;
    const nextDistro = pendingWslChange.nextDistro;
    setPendingWslChange(null);
    const persistedDistro = desktopWslState?.distro ?? null;
    void applyWslSettingChange(() =>
      applyWslEnableSelection({
        bridge: desktopBridge,
        mode,
        nextDistro,
        persistedDistro,
      }),
    );
  };

  const handleToggleWslOnly = (enabled: boolean) => {
    if (!desktopBridge || !desktopWslState || desktopWslState.wslOnly === enabled) return;
    setPendingWslChange({ kind: "wsl-only", nextValue: enabled });
  };

  const handleConfirmWslChange = () => {
    if (!desktopBridge || !pendingWslChange) return;
    const change = pendingWslChange;
    if (change.kind === "enable") return;
    setPendingWslChange(null);
    if (change.kind === "disable") {
      void applyWslSettingChange(async () => {
        const next = await desktopBridge.setWslBackendEnabled(false);
        if (change.wasWslOnly) {
          return await desktopBridge.setWslOnly(false);
        }
        return next;
      });
      return;
    }
    if (change.kind === "distro") {
      void applyWslSettingChange(() => desktopBridge.setWslDistro(change.nextDistro));
      return;
    }
    void applyWslSettingChange(() => desktopBridge.setWslOnly(change.nextValue));
  };

  const renderWslRow = () => {
    if (!desktopWslState) {
      if (
        isWslSettingsRowVisible({ state: null, error: desktopWslError }) &&
        canManageLocalBackend
      ) {
        return (
          <SettingsRow
            {...searchableSetting("wsl-backend")}
            description="Couldn't load the WSL backend state."
            status={<span className="block text-destructive">{desktopWslError}</span>}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={loadWslState}
                disabled={isLoadingWslState}
              >
                {isLoadingWslState ? "Retrying…" : "Retry"}
              </Button>
            }
          />
        );
      }
      return null;
    }
    if (!isWslSettingsRowVisible({ state: desktopWslState, error: desktopWslError })) {
      return null;
    }
    if (!desktopWslState.available) {
      return (
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description="WSL is unavailable, so Windows is running instead. Turn WSL off to clear this preference."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : null
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdatingWslBackend}
              onClick={() => handleSelectWslMode(BACKEND_VALUE_WSL_OFF)}
            >
              Switch to Windows
            </Button>
          }
        />
      );
    }
    const defaultDistroName =
      desktopWslState.distros.find((distro) => distro.isDefault)?.name ?? null;
    const selectValue = !desktopWslState.enabled
      ? BACKEND_VALUE_WSL_OFF
      : (desktopWslState.distro ?? defaultDistroName ?? BACKEND_VALUE_DEFAULT_WSL);
    const selectLabel =
      selectValue === BACKEND_VALUE_WSL_OFF
        ? "Off"
        : selectValue === BACKEND_VALUE_DEFAULT_WSL
          ? "Default distro"
          : selectValue;
    return (
      <>
        <SettingsRow
          {...searchableSetting("wsl-backend")}
          description="Run the selected WSL distro alongside Windows. Projects remain on their current filesystem."
          status={
            desktopWslError ? (
              <span className="block text-destructive">{desktopWslError}</span>
            ) : desktopWslState.preflightError ? (
              <span className="block text-destructive">
                WSL backend couldn't start: {desktopWslState.preflightError}
              </span>
            ) : null
          }
          control={
            <Select
              value={selectValue}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                handleSelectWslMode(value);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-56"
                aria-label="WSL backend"
                disabled={isUpdatingWslBackend}
              >
                <SelectValue>{selectLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={BACKEND_VALUE_WSL_OFF}>
                  Off
                </SelectItem>
                {desktopWslState.distros.length === 0 ? (
                  <SelectItem hideIndicator value={BACKEND_VALUE_DEFAULT_WSL}>
                    Default distro
                  </SelectItem>
                ) : (
                  desktopWslState.distros.map((distro) => (
                    <SelectItem hideIndicator key={distro.name} value={distro.name}>
                      {distro.name}
                      {distro.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))
                )}
              </SelectPopup>
            </Select>
          }
        />
        {desktopWslState.enabled ? (
          <SettingsRow
            title="WSL only"
            description={`Run only the WSL backend. ${APP_BASE_NAME} restarts when this changes.`}
            className="bg-muted/20 pl-7 sm:pl-8"
            control={
              <Switch
                checked={desktopWslState.wslOnly}
                disabled={isUpdatingWslBackend}
                onCheckedChange={(checked) => handleToggleWslOnly(checked)}
                aria-label="Run WSL only"
              />
            }
          />
        ) : null}
      </>
    );
  };

  return (
    <>
      {renderWslRow()}
      <AlertDialog
        open={isWslConfirmDialogOpen && canManageLocalBackend}
        onOpenChange={(open) => {
          if (isUpdatingWslBackend) return;
          if (!open) setPendingWslChange(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingWslChange?.kind === "disable"
                ? pendingWslChange.wasWslOnly
                  ? "Turn off WSL and switch back to Windows?"
                  : "Disable WSL backend?"
                : pendingWslChange?.kind === "distro"
                  ? "Switch WSL distro?"
                  : pendingWslChange?.kind === "enable"
                    ? "Start the WSL backend"
                    : pendingWslChange?.nextValue
                      ? "Run only the WSL backend?"
                      : "Re-enable the Windows backend?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingWslChange?.kind === "disable"
                ? pendingWslChange.wasWslOnly
                  ? `${APP_BASE_NAME} will restart on the Windows backend. Threads and projects opened against WSL stay safe inside the distro and become available again when you re-enable WSL.`
                  : `The WSL backend will stop. Threads and projects opened against WSL stay safe inside the distro, but they'll be unavailable in ${APP_BASE_NAME} until you re-enable WSL.`
                : pendingWslChange?.kind === "distro"
                  ? `${APP_BASE_NAME} will restart the WSL backend on the new distro. Sessions still running on the current distro will be interrupted.`
                  : pendingWslChange?.kind === "enable"
                    ? "Run the WSL backend alongside the Windows one, or stop the Windows backend and use only WSL? You can change this later from Settings."
                    : pendingWslChange?.nextValue
                      ? `${APP_BASE_NAME} will restart and start only the WSL backend. Your Windows-side projects won't be accessible until you turn this off again.`
                      : `${APP_BASE_NAME} will restart and bring the Windows backend back up alongside WSL.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isUpdatingWslBackend}
              render={<Button variant="outline" disabled={isUpdatingWslBackend} />}
            >
              Cancel
            </AlertDialogClose>
            {pendingWslChange?.kind === "enable" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => handleConfirmEnableWsl("wsl-only")}
                  disabled={isUpdatingWslBackend || !canManageLocalBackend}
                >
                  {isUpdatingWslBackend ? (
                    <>
                      <Spinner size="sm" />
                      Applying…
                    </>
                  ) : (
                    "Use only WSL"
                  )}
                </Button>
                <Button
                  variant="default"
                  onClick={() => handleConfirmEnableWsl("both")}
                  disabled={isUpdatingWslBackend || !canManageLocalBackend}
                >
                  {isUpdatingWslBackend ? (
                    <>
                      <Spinner size="sm" />
                      Applying…
                    </>
                  ) : (
                    "Run both backends"
                  )}
                </Button>
              </>
            ) : (
              <Button
                variant={
                  pendingWslChange?.kind === "disable" ||
                  (pendingWslChange?.kind === "wsl-only" && pendingWslChange.nextValue)
                    ? "destructive"
                    : "default"
                }
                onClick={handleConfirmWslChange}
                disabled={isUpdatingWslBackend || !canManageLocalBackend}
              >
                {isUpdatingWslBackend ? (
                  <>
                    <Spinner size="sm" />
                    Applying…
                  </>
                ) : pendingWslChange?.kind === "disable" ? (
                  pendingWslChange.wasWslOnly ? (
                    "Switch to Windows"
                  ) : (
                    "Disable WSL"
                  )
                ) : pendingWslChange?.kind === "distro" ? (
                  "Switch distro"
                ) : pendingWslChange?.nextValue ? (
                  "Restart and enable"
                ) : (
                  "Restart and disable"
                )}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
