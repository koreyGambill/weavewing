import {
  AuthDiagnosticsReadScope,
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  type AuthGrantScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  AuthTerminalReadScope,
} from "@t3tools/contracts";

import {
  type LinkLevelChoice,
  type ReachModel,
  type ReachParty,
  type ReachSquare,
  squareKey,
} from "./reachModel.logic";

export type DeviceLevel = "read-only" | "full-access";

const VIEW_ONLY_SCOPES: ReadonlyArray<AuthGrantScope> = [
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
];

/** What a new device may do at a level, limited to what this app may hand out there. */
export function deviceScopes(
  level: DeviceLevel,
  delegatable: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthGrantScope> {
  const preset = level === "read-only" ? VIEW_ONLY_SCOPES : AuthStandardClientScopes;
  return preset.filter((scope) => delegatable.includes(scope));
}

export interface ConnectChoice {
  /** Servers the new computer may use, at `usesLevel`. */
  readonly uses: ReadonlyArray<ReachParty>;
  readonly usesLevel: LinkLevelChoice;
  /** Servers that may use the new computer, at `usedByLevel`. */
  readonly usedBy: ReadonlyArray<ReachParty>;
  readonly usedByLevel: LinkLevelChoice;
}

export interface ConnectLine {
  readonly square: ReachSquare;
  readonly target: LinkLevelChoice;
  /** Why this line cannot be made from here; it is shown and skipped. */
  readonly blocked: string | null;
}

/** The links a "Connect" click makes for `computer`, both ways, each one a square. */
export function planConnect(
  model: ReachModel,
  computer: ReachParty,
  choice: ConnectChoice,
): ReadonlyArray<ConnectLine> {
  const line = (from: ReachParty, to: ReachParty, target: LinkLevelChoice): ConnectLine[] => {
    const square = model.squares.get(squareKey(from.id, to.id));
    if (square === undefined) return [];
    const current = square.state.kind === "level" ? square.state.level : null;
    const unchanged = current === target && square.state.kind === "level" && !square.state.broken;
    if (unchanged) return [];
    return [
      {
        square,
        target,
        blocked:
          square.state.kind === "no-path"
            ? `No path: ${to.label} has no address ${from.label} can reach`
            : square.changes.canRelink
              ? null
              : (square.changes.relinkBlockedReason ?? "This app cannot change it"),
      },
    ];
  };
  return [
    ...choice.uses.flatMap((server) => line(computer, server, choice.usesLevel)),
    ...choice.usedBy.flatMap((server) => line(server, computer, choice.usedByLevel)),
  ];
}

/** Full access both ways with every chosen server makes the computer one of the trusted. */
export function joinsTrusted(choice: ConnectChoice): boolean {
  const uses = new Set(choice.uses.map((server) => server.id));
  return (
    choice.uses.length > 0 &&
    choice.usesLevel === "full-access" &&
    choice.usedByLevel === "full-access" &&
    choice.usedBy.length === uses.size &&
    choice.usedBy.every((server) => uses.has(server.id))
  );
}
