import { linkableMachines, linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { useState } from "react";

import { desktopSameHostEnvironmentIds } from "~/connection/desktopLocal";
import { useDesktopLocalBootstraps } from "~/connection/useDesktopLocalBootstraps";
import { authEnvironment } from "~/state/auth";
import { useEnvironments } from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  type LinkLevelChoice,
  planSquareChange,
  type ReachSquare,
  type SquareChangePlan,
  type SquareTarget,
} from "./reachModel.logic";

type ConfirmablePlan = Exclude<SquareChangePlan, { readonly kind: "blocked" }>;

export interface SquareChangeState {
  /** A change waiting for its confirm click, with the sentence that says what it does. */
  readonly pending: { readonly key: string; readonly plan: ConfirmablePlan } | null;
  readonly busyKey: string | null;
  readonly errors: ReadonlyMap<string, string>;
  readonly request: (square: ReachSquare, target: SquareTarget) => void;
  readonly confirm: () => void;
  readonly cancel: () => void;
  /** Applies at once and settles to the failure, or null. */
  readonly applyNow: (square: ReachSquare, target: SquareTarget) => Promise<string | null>;
}

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
};

const keyOf = (square: ReachSquare) => `${square.from.id}>${square.to.id}`;

/**
 * Changes one "From X to Y" line. Raising relinks X with a fresh code from Y; removing ends
 * the sessions on Y and forgets the link on X when this app may. A half-done change says
 * which half failed, and leaves the old state standing.
 */
export function useSquareChange(): SquareChangeState {
  const { environments } = useEnvironments();
  const bootstraps = useDesktopLocalBootstraps();
  const link = useAtomCommand(peerLinkEnvironment.link, { reportFailure: false });
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { reportFailure: false });
  const revokeClient = useAtomCommand(authEnvironment.revokeClient, { reportFailure: false });
  const [pending, setPending] = useState<SquareChangeState["pending"]>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const setError = (key: string, message: string | null) =>
    setErrors((current) => {
      const next = new Map(current);
      if (message === null) next.delete(key);
      else next.set(key, message);
      return next;
    });

  const targetUrls = (fromId: EnvironmentId, toId: EnvironmentId) =>
    linkableMachines({
      environments,
      threadEnvironmentId: fromId,
      links: [],
      connect: new Map(),
      sameHost: desktopSameHostEnvironmentIds(environments, bootstraps),
    }).find((machine) => machine.environmentId === toId)?.urls ?? [];

  const relink = async (square: ReachSquare, target: LinkLevelChoice) => {
    const fromId = square.from.environmentId!;
    const toId = square.to.environmentId!;
    const from = square.from.label;
    const to = square.to.label;
    const [url, ...alternateUrls] =
      square.link !== null && square.link.urls.length > 0
        ? square.link.urls
        : targetUrls(fromId, toId);
    if (url === undefined) return `${from} has no address for ${to}. Nothing changed.`;
    const code = await mintPairingCodeOn(toId, target);
    if (Result.isFailure(code)) {
      return `Could not get a code from ${to}: ${linkRequestFailureMessage(code.failure)} Nothing changed.`;
    }
    const linked = await link({
      environmentId: fromId,
      input: {
        url,
        ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
        expectedEnvironmentId: toId,
        expectedLabel: to,
        pairingCode: code.success,
        access: target,
      },
    });
    if (linked._tag === "Success" || isAtomCommandInterrupted(linked)) return null;
    return `${to} issued a code, but ${from} could not link: ${failureText(linked)} The old level still applies, and the unused code expires on its own.`;
  };

  const remove = async (square: ReachSquare) => {
    const toId = square.to.environmentId!;
    const fromId = square.from.environmentId;
    const revokeOnTarget = square.changes.lockedReason === null;
    if (revokeOnTarget) {
      for (const sessionId of square.sessionIds) {
        const revoked = await revokeClient({ environmentId: toId, input: { sessionId } });
        if (revoked._tag === "Failure" && !isAtomCommandInterrupted(revoked)) {
          return `Could not end ${square.from.label}'s access on ${square.to.label}: ${failureText(revoked)}`;
        }
      }
    }
    if (square.link === null || fromId === null) return null;
    const unlinked = await unlink({ environmentId: fromId, input: { environmentId: toId } });
    if (unlinked._tag === "Success" || isAtomCommandInterrupted(unlinked)) return null;
    return revokeOnTarget && square.sessionIds.length > 0
      ? `${square.to.label} no longer accepts ${square.from.label}, but ${square.from.label} still lists the link: ${failureText(unlinked)}`
      : `${square.from.label} could not forget its link: ${failureText(unlinked)}`;
  };

  const run = async (square: ReachSquare, plan: Exclude<SquareChangePlan, { kind: "blocked" }>) => {
    const key = keyOf(square);
    setBusyKey(key);
    setError(key, null);
    const failure =
      plan.action === "remove" ? await remove(square) : await relink(square, plan.target);
    setBusyKey(null);
    setError(key, failure);
    return failure;
  };

  // The square stays in hand until its confirm click, so the confirm acts on what was shown.
  const [pendingSquare, setPendingSquare] = useState<ReachSquare | null>(null);
  const request = (square: ReachSquare, target: SquareTarget) => {
    const plan = planSquareChange(square, target);
    const key = keyOf(square);
    if (plan.kind === "blocked") {
      setError(key, plan.reason);
      return;
    }
    if (plan.kind === "confirm") {
      setError(key, null);
      setPending({ key, plan });
      setPendingSquare(square);
      return;
    }
    setPending(null);
    void run(square, plan);
  };
  const confirm = () => {
    if (pending === null || pendingSquare === null) return;
    const plan = pending.plan;
    setPending(null);
    setPendingSquare(null);
    void run(pendingSquare, plan);
  };
  const cancel = () => {
    setPending(null);
    setPendingSquare(null);
  };

  // For a caller that already showed what will happen, such as the Connect wizard's summary.
  const applyNow = async (square: ReachSquare, target: SquareTarget) => {
    const plan = planSquareChange(square, target);
    if (plan.kind !== "blocked") return run(square, plan);
    setError(keyOf(square), plan.reason);
    return plan.reason;
  };

  return { pending, busyKey, errors, request, confirm, cancel, applyNow };
}
