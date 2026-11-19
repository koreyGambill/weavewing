import { linkableMachines, linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { RegistryContext } from "@effect/atom-react";
import { useContext, useState } from "react";

import { desktopSameHostEnvironmentIds } from "~/connection/desktopLocal";
import { useDesktopLocalBootstraps } from "~/connection/useDesktopLocalBootstraps";
import { authEnvironment } from "~/state/auth";
import { useEnvironments } from "~/state/environments";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useAtomCommand } from "~/state/use-atom-command";
import { type RelinkOutcome, runRelink, settleUncertain } from "./relink.logic";
import {
  type LinkLevelChoice,
  planSquareChange,
  REACH_LEVEL_LABELS,
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
  /** Lines whose link may have changed on the target while saving it here failed. */
  readonly uncertain: ReadonlySet<string>;
  readonly linkAgain: (key: string) => void;
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
 * the sessions on Y and forgets the link on X when this app may. A relink that fails once Y may
 * have changed says the access is uncertain and offers to link again.
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
  const [uncertain, setUncertain] = useState<
    ReadonlyMap<string, { readonly square: ReachSquare; readonly target: LinkLevelChoice | null }>
  >(new Map());
  const registry = useContext(RegistryContext);

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

  const relink = async (square: ReachSquare, target: LinkLevelChoice): Promise<RelinkOutcome> => {
    const fromId = square.from.environmentId!;
    const toId = square.to.environmentId!;
    const [url, ...alternateUrls] =
      square.link !== null && square.link.urls.length > 0
        ? square.link.urls
        : targetUrls(fromId, toId);
    const outcome = await runRelink({
      from: square.from.label,
      to: square.to.label,
      current: uncertain.has(keyOf(square))
        ? null
        : square.state.kind === "level"
          ? REACH_LEVEL_LABELS[square.state.level]
          : "no access",
      hasAddress: url !== undefined,
      mint: async () => {
        const code = await mintPairingCodeOn(toId, target);
        return Result.isSuccess(code)
          ? { code: code.success }
          : { failure: linkRequestFailureMessage(code.failure) };
      },
      link: async (pairingCode) => {
        const linked = await link({
          environmentId: fromId,
          input: {
            url: url!,
            ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
            expectedEnvironmentId: toId,
            expectedLabel: square.to.label,
            pairingCode,
            access: target,
          },
        });
        return linked._tag === "Success" || isAtomCommandInterrupted(linked)
          ? null
          : { failure: failureText(linked) };
      },
    });
    if (outcome.kind === "uncertain") {
      // Read the source's links again so the page shows what it holds now, not the old level.
      registry.refresh(peerLinkEnvironment.list({ environmentId: fromId, input: {} }));
    }
    return outcome;
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
    const outcome: RelinkOutcome =
      plan.action === "relink"
        ? await relink(square, plan.target)
        : await remove(square).then((message) =>
            message === null ? { kind: "done" } : { kind: "unchanged", message },
          );
    const target = plan.action === "relink" ? plan.target : null;
    setUncertain((current) => settleUncertain(current, key, outcome.kind, { square, target }));
    setBusyKey(null);
    const failure = outcome.kind === "done" ? null : outcome.message;
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

  // The one way out of an uncertain link: link again at the level that was asked for.
  const linkAgain = (key: string) => {
    const entry = uncertain.get(key);
    if (entry !== undefined && entry.target !== null)
      void run(entry.square, {
        kind: "apply",
        action: "relink",
        target: entry.target,
        sentence: null,
      });
  };

  return {
    pending,
    busyKey,
    errors,
    uncertain: new Set(uncertain.keys()),
    request,
    confirm,
    cancel,
    applyNow,
    linkAgain,
  };
}
