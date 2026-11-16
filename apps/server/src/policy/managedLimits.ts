/**
 * managedLimits - the managed policy restrictions on server reachability, and the
 * one error every refusal uses so each transport can show the administrator's organization.
 *
 * @module managedLimits
 */
import type {
  ManagedPolicyClient,
  ManagedPolicyDocument,
  ServerAuthPolicy,
} from "@t3tools/contracts";
import {
  disableTailscaleServe,
  disableTailscaleServeTcp,
  readTailscaleServeRoutesTo,
  tailscaleServeOffArgs,
  readTailscaleStatus,
  type TailscaleServeRoute,
  type TailscaleStderrDiagnostic,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as NetService from "@t3tools/shared/Net";

import { loopbackBindAddress } from "../auth/utils.ts";

type PolicyDocument = { readonly document: ManagedPolicyDocument | undefined };

export class ManagedPolicyRefusedError extends Schema.TaggedError<ManagedPolicyRefusedError>()(
  "ManagedPolicyRefusedError",
  {
    organization: Schema.String,
    /** What the policy does not allow, for example "T3 Connect". */
    action: Schema.String,
    /** What that means for this request, for example "so the server cannot listen on 0.0.0.0". */
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return `${this.organization}'s policy does not allow ${this.action}${
      this.detail === undefined ? "" : `, ${this.detail}`
    }.`;
  }
}

const CLIENT_AUTH_POLICY: Record<ManagedPolicyClient, ServerAuthPolicy> = {
  desktop: "desktop-managed-local",
  "local-browser": "loopback-browser",
  remote: "remote-reachable",
};

const AUTH_POLICY_ACTION: Record<ServerAuthPolicy, string> = {
  "desktop-managed-local": "the desktop app",
  "loopback-browser": "browsers on this machine",
  "remote-reachable": "remote clients",
  "unsafe-no-auth": "running without authentication",
};

/** Whether the server may run with `authPolicy`. Any policy file rules out `unsafe-no-auth`. */
export function allowsAuthPolicy(policy: PolicyDocument, authPolicy: ServerAuthPolicy): boolean {
  if (policy.document === undefined) return true;
  if (authPolicy === "unsafe-no-auth") return false;
  const clients = policy.document.limits?.clients;
  return (
    clients === undefined || clients.some((client) => CLIENT_AUTH_POLICY[client] === authPolicy)
  );
}

/** Whether anything off this machine may pair, by LAN, Tailscale, or a minted link. */
export const allowsRemoteClients = (policy: PolicyDocument) =>
  allowsAuthPolicy(policy, "remote-reachable");

/** T3 Connect is a way for remote clients in, so a policy without `remote` turns it off too. */
export const allowsConnect = (policy: PolicyDocument) =>
  policy.document?.limits?.connect !== false && allowsRemoteClients(policy);

/** Serve also requires remote clients to be allowed. */
export const allowsTailscaleServe = (policy: PolicyDocument) =>
  policy.document?.limits?.tailscaleServe !== false && allowsRemoteClients(policy);

const refuse = (policy: PolicyDocument, action: string, detail?: string) =>
  new ManagedPolicyRefusedError({
    organization: policy.document?.organization ?? "Your organization",
    action,
    ...(detail === undefined ? {} : { detail }),
  });

export const refuseConnect = (policy: PolicyDocument) => refuse(policy, "T3 Connect");

// Node throws ENOTDIR, outside the spawner's error mapping, when PATH ends in a file.
const isMissingCli = (cause: unknown) =>
  (PlatformError.isPlatformError(cause) && cause.reason._tag === "NotFound") ||
  (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR");

const NOTHING_FORWARDED: ReadonlyArray<TailscaleServeRoute> = [];

/** Tailscale answers that leave nothing forwarding here right now. */
const NOTHING_TO_CLOSE: ReadonlySet<TailscaleStderrDiagnostic | undefined> = new Set([
  "not-running",
  "not-logged-in",
]);

/**
 * Closes only Serve routes forwarding to `target` before bind, and verifies their removal.
 * An initial probe timeout warns and permits startup without verifying existing routes.
 * Missing CLI, stopped daemon, or logged-out Tailscale has no active forwards.
 */
export const closeTailscaleServeTo = Effect.fn("managedLimits.closeTailscaleServeTo")(function* (
  policy: PolicyDocument,
  target: { readonly host: string; readonly port: number },
) {
  if (allowsTailscaleServe(policy)) return;
  // Another app holds the port, so its routes are not ours to remove. It could let go before the
  // bind, which would then take over those routes, so the server does not start.
  if (!(yield* (yield* NetService.NetService).canListenOnHost(target.port, target.host))) {
    return yield* refuse(
      policy,
      "Tailscale Serve",
      `so the server does not start while it cannot bind ${target.host}:${target.port}; if another app holds that port, the server would take over its Tailscale Serve routes`,
    );
  }
  const readRoutes = (initial: boolean) =>
    readTailscaleServeRoutesTo(target).pipe(
      Effect.catchTags({
        // WSL interop can hang before answering; a known route still needs verified removal.
        TailscaleCommandTimeoutError: (error) =>
          initial
            ? Effect.logWarning(
                "Tailscale Serve check timed out; starting without verifying existing routes",
              ).pipe(Effect.as(NOTHING_FORWARDED))
            : Effect.fail(error),
        // Only a CLI that is not there; one that will not run might still front a daemon.
        TailscaleCommandSpawnError: (error) =>
          isMissingCli(error.cause) ? Effect.succeed(NOTHING_FORWARDED) : Effect.fail(error),
        TailscaleCommandExitError: (error) =>
          NOTHING_TO_CLOSE.has(error.stderrDiagnostic)
            ? Effect.succeed(NOTHING_FORWARDED)
            : Effect.fail(error),
      }),
      // Tailscale errors carry only labelled diagnostics, never raw stderr, so they are safe to log.
      Effect.tapError((cause) =>
        Effect.logWarning("Tailscale Serve could not be checked", { cause }),
      ),
      Effect.mapError((error) =>
        refuse(
          policy,
          "Tailscale Serve",
          error._tag === "TailscaleCommandTimeoutError"
            ? // Seen on a Mac where Tailscale is installed but was never set up.
              "so the server does not start until Tailscale Serve can be checked, and Tailscale did not answer; open Tailscale and finish setting it up, or remove it"
            : "so the server does not start until Tailscale Serve can be checked",
        ),
      ),
    );
  const found = yield* readRoutes(true);
  if (found.length === 0) return;
  // `off` acts on the machine's current name, so a web route under a former name stays.
  const currentName = found.some((route) => route.mount !== undefined && route.owner === undefined)
    ? yield* readTailscaleStatus.pipe(
        Effect.map((status) => status.magicDnsName?.toLowerCase() ?? null),
        Effect.orElseSucceed(() => null),
      )
    : null;
  const formerName = (route: TailscaleServeRoute) =>
    route.owner === undefined &&
    route.host !== undefined &&
    currentName !== null &&
    route.host.toLowerCase() !== currentName;
  // A Service is shared across the tailnet, and a foreground route lives as long as its command.
  const removable = (route: TailscaleServeRoute) =>
    route.owner === undefined &&
    route.ambiguous === undefined &&
    (route.mount === undefined || (currentName !== null && !formerName(route)));
  for (const route of found.filter(removable)) {
    yield* (
      route.mount === undefined
        ? disableTailscaleServeTcp(route.servePort)
        : disableTailscaleServe(route)
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Tailscale Serve route could not be turned off", { ...route, cause }),
      ),
    );
  }
  const left = yield* readRoutes(false);
  if (left.length > 0) {
    const describe = (route: TailscaleServeRoute) => {
      const where = `port ${route.servePort}${route.mount === undefined ? "" : ` at ${route.mount}`} here`;
      const off = tailscaleServeOffArgs(route);
      if (off === undefined) return `${where}; stop the "tailscale serve" command that runs it`;
      if (formerName(route)) {
        return `${where} under ${route.host}, a former name of this machine, which "tailscale serve ... off" cannot reach; run "tailscale serve reset" and set up your other routes again`;
      }
      const command = `"tailscale ${off.join(" ")}"`;
      // Without the current name, `off` might act on another name's route at this path.
      if (currentName === null && route.owner === undefined && route.host !== undefined) {
        return `${where} under ${route.host}; if that is this machine's current name, turn it off with ${command}`;
      }
      return route.ambiguous !== undefined
        ? `${where}, and its target ${route.ambiguous} might be another service on this port; check it, then turn it off with ${command}`
        : `${where}; turn it off with ${command}`;
    };
    return yield* refuse(
      policy,
      "Tailscale Serve",
      `so the server does not start while Tailscale Serve forwards ${left.map(describe).join(", and ")}`,
    );
  }
  yield* Effect.logInfo("Turned off Tailscale Serve the managed policy does not allow", {
    routes: found,
  });
});

export const refuseRemoteClients = (policy: PolicyDocument, detail?: string) =>
  refuse(policy, AUTH_POLICY_ACTION["remote-reachable"], detail);

/**
 * Fails when the server would accept clients the policy leaves out; otherwise returns the address
 * to bind. Runs before the server binds, so a refused configuration never listens, not even
 * briefly. Without `remote` that address is the loopback literal the check approved, never a name.
 */
export const checkServerReachability = Effect.fn("managedLimits.checkServerReachability")(
  function* (
    policy: PolicyDocument,
    input: {
      readonly authPolicy: ServerAuthPolicy;
      readonly host: string | undefined;
      readonly tailscaleServeEnabled: boolean;
      /** The background service chose `host` to reach private networks; the user did not. */
      readonly privateNetworkOnly?: boolean | undefined;
    },
  ) {
    const cannotListen = () =>
      refuseRemoteClients(
        policy,
        input.privateNetworkOnly === true
          ? "so the background service cannot listen on private networks; set T3CODE_HOST=127.0.0.1 in its service.env"
          : `so the server cannot listen on ${input.host === "" ? "every interface" : (input.host ?? "this host")}`,
      );
    if (!allowsAuthPolicy(policy, input.authPolicy)) {
      return yield* input.authPolicy === "remote-reachable"
        ? cannotListen()
        : refuse(policy, AUTH_POLICY_ACTION[input.authPolicy]);
    }
    if (input.tailscaleServeEnabled && !allowsTailscaleServe(policy)) {
      return yield* refuse(policy, "Tailscale Serve", "so Tailscale Serve cannot be turned on");
    }
    if (allowsRemoteClients(policy)) return input.host ?? "127.0.0.1";
    return loopbackBindAddress(input.host) ?? (yield* cannotListen());
  },
);
