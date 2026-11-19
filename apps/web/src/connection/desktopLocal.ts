import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
} from "@t3tools/contracts";

const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function desktopLocalConnectionId(backendId: string): string {
  return `${DESKTOP_LOCAL_CONNECTION_ID_PREFIX}${backendId}`;
}

export function isDesktopLocalConnectionTarget(
  target: ConnectionTarget,
): target is Extract<ConnectionTarget, { readonly _tag: "BearerConnectionTarget" }> {
  return (
    target._tag === "BearerConnectionTarget" &&
    target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)
  );
}

/**
 * The environments on this desktop's host loopback: its primary, and the local
 * backends that share the host's network stack. A NAT WSL backend's loopback is its VM's.
 */
export function desktopSameHostEnvironmentIds(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly entry: { readonly target: ConnectionTarget };
  }>,
  bootstraps: ReadonlyArray<Pick<DesktopEnvironmentBootstrap, "id" | "sharesHostLoopback">>,
): ReadonlySet<EnvironmentId> {
  const sharing = new Set(
    bootstraps.flatMap((bootstrap) =>
      bootstrap.sharesHostLoopback === true ? [bootstrap.id] : [],
    ),
  );
  return new Set(
    environments.flatMap(({ environmentId, entry }) => {
      const backendId = desktopLocalBackendId(entry.target);
      return entry.target._tag === "PrimaryConnectionTarget" ||
        (backendId !== null && sharing.has(backendId))
        ? [environmentId]
        : [];
    }),
  );
}

export function desktopLocalBackendId(target: ConnectionTarget): string | null {
  return isDesktopLocalConnectionTarget(target)
    ? target.connectionId.slice(DESKTOP_LOCAL_CONNECTION_ID_PREFIX.length)
    : null;
}

export type DesktopSecondaryBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export interface DesktopSecondaryBootstrapsReader {
  readonly readResult: () => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
}

/** Empty reads clear the snapshot; failed reads retain platform registrations. */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => Pick<DesktopBridge, "getLocalEnvironmentBootstraps"> | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

  const readResult = (): DesktopSecondaryBootstrapsRead => {
    const bridge = resolveBridge();
    if (bridge === undefined) {
      if (snapshot.length > 0) snapshot = [];
      return { _tag: "Success", bootstraps: snapshot };
    }
    try {
      const next = bridge
        .getLocalEnvironmentBootstraps()
        .filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
      if (
        next.length !== snapshot.length ||
        next.some((entry, index) => {
          const previous = snapshot[index];
          return (
            previous === undefined ||
            entry.id !== previous.id ||
            entry.label !== previous.label ||
            entry.runningDistro !== previous.runningDistro ||
            entry.httpBaseUrl !== previous.httpBaseUrl ||
            entry.wsBaseUrl !== previous.wsBaseUrl ||
            entry.bootstrapToken !== previous.bootstrapToken ||
            entry.sharesHostLoopback !== previous.sharesHostLoopback
          );
        })
      ) {
        snapshot = next;
      }
      return { _tag: "Success", bootstraps: snapshot };
    } catch (cause) {
      return { _tag: "Failure", cause };
    }
  };

  return {
    readResult,
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(
  () => window.desktopBridge,
);

export function readDesktopSecondaryBootstrapsResult(): DesktopSecondaryBootstrapsRead {
  return desktopSecondaryBootstrapsReader.readResult();
}

export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}

export const desktopLocalRefreshes = (
  resolveBridge: () => Pick<DesktopBridge, "onLocalEnvironmentReady"> | undefined,
) =>
  Stream.merge(
    Stream.tick("3 seconds"),
    Stream.callback<void>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          resolveBridge()?.onLocalEnvironmentReady?.(() => Queue.offerUnsafe(queue, undefined)),
        ),
        (unsubscribe) => Effect.sync(() => unsubscribe?.()),
      ).pipe(Effect.asVoid),
    ),
  );
