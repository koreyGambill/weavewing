import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  qaCardStatus,
  qaCardTitle,
  qaKey,
  qaNoted,
  qaPresence,
  qaRef,
  type QaChange,
} from "@t3tools/client-runtime/qa-card";
import type {
  EnvironmentId,
  EvidenceLanding,
  EvidenceLandingSummary,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadShell } from "../../state/entities";
import { evidenceGet } from "../../state/evidence";
import { useEnvironmentQuery } from "../../state/query";
import type { InboxThreadTarget } from "../inbox/inbox.logic";
import { QA_STATUS_LABEL } from "../threads/waiting/mobileQaCard.logic";
import { useQaKeysInComposer } from "../threads/waiting/qaDiscuss";
import { WaitingQaCard } from "../threads/waiting/WaitingQaCard";
import { landingQaSummary, landingQaThreadId, landingTargetLine } from "./evidence.logic";
import { EvidenceNotePreview } from "./EvidenceNotePreview";

/**
 * One landing: its title, thread, when and where it landed, and its QA counts. Opening it reads
 * its changes; tapping a change opens its details.
 */
export function EvidenceLandingCard(props: {
  readonly environmentId: EnvironmentId;
  readonly landing: EvidenceLandingSummary;
  readonly defaultOpen: boolean;
  /** The change whose card is open, as `environmentId:landingId/changeId`; one in the sheet. */
  readonly expandedChange: string | null;
  readonly onToggleChange: (key: string) => void;
  readonly onOpenThread: (thread: InboxThreadTarget) => void;
}) {
  const { environmentId, landing } = props;
  const [open, setOpen] = useState(props.defaultOpen);
  const thread = useThreadShell(scopeThreadRef(environmentId, landing.threadId));
  const threadLabel = thread?.title ?? "another thread";
  return (
    <View className="rounded-2xl border border-border-subtle bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${landing.title}, in ${threadLabel}, ${landingQaSummary(landing)}`}
        onPress={() => setOpen(!open)}
        className="min-h-11 flex-row items-start gap-2 rounded-2xl px-3.5 py-3 active:bg-subtle"
      >
        <View className="min-w-0 flex-1 gap-1">
          <Text
            selectable={open}
            numberOfLines={open ? undefined : 2}
            className="font-t3-bold text-sm text-foreground"
          >
            {landing.title}
          </Text>
          <Text
            numberOfLines={open ? undefined : 1}
            className="font-sans text-xs text-foreground-secondary"
          >
            in {threadLabel}
          </Text>
          <Text className="font-sans text-xs text-foreground-muted">
            <RelativeTime timestamp={landing.landedAt} /> · {landingTargetLine(landing)}
          </Text>
          <Text
            className={cn(
              "font-sans text-xs",
              landing.qa.pending > 0 || landing.qa.problem > 0
                ? "text-warning-foreground"
                : "text-foreground-muted",
            )}
          >
            {landingQaSummary(landing)}
          </Text>
        </View>
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={11}
          tintColorClassName="accent-foreground-muted"
        />
      </Pressable>
      {!open && landing.notes?.length ? (
        <View className="gap-1 border-t border-border-subtle px-2 py-2">
          {landing.notes.map((note) => (
            <EvidenceNotePreview
              key={note.id}
              environmentId={environmentId}
              landingId={landing.id}
              note={note}
              onOpen={() => {
                setOpen(true);
                const key = `${environmentId}:${qaKey(landing.id, note.id)}`;
                if (props.expandedChange !== key) props.onToggleChange(key);
              }}
            />
          ))}
        </View>
      ) : null}
      {open ? (
        <LandingChanges
          environmentId={environmentId}
          landingId={landing.id}
          expandedChange={props.expandedChange}
          onToggleChange={props.onToggleChange}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
    </View>
  );
}

/** Mounted only while its landing is open, so its read ends when the landing closes. */
function LandingChanges(props: {
  readonly environmentId: EnvironmentId;
  readonly landingId: string;
  readonly expandedChange: string | null;
  readonly onToggleChange: (key: string) => void;
  readonly onOpenThread: (thread: InboxThreadTarget) => void;
}) {
  const { environmentId } = props;
  const query = useEnvironmentQuery(
    evidenceGet({ environmentId, input: { landingId: props.landingId } }),
  );
  const landing = query.data;
  if (landing === null)
    return (
      <View className="gap-2 border-t border-border-subtle px-3.5 py-3">
        {query.error === null ? (
          <Text className="font-sans text-sm text-foreground-secondary">Loading changes…</Text>
        ) : (
          <>
            <Text selectable className="font-sans text-sm text-danger-foreground">
              Could not load this landing: {query.error}
            </Text>
            <Button label="Try again" onPress={query.refresh} />
          </>
        )}
      </View>
    );
  const qaThreadId = landingQaThreadId(landing);
  return (
    <View className="gap-2 border-t border-border-subtle px-2 py-2">
      {landing.exempt ? (
        <Text selectable className="px-2 font-sans text-sm text-foreground-muted">
          No changes to check. This exemption covers the commits landed up to{" "}
          {landing.target.sha.slice(0, 7)}.
        </Text>
      ) : null}
      {landing.changes.map((change) => {
        const key = `${environmentId}:${qaKey(landing.id, change.id)}`;
        return (
          <ChangeRow
            key={change.id}
            environmentId={environmentId}
            landing={landing}
            change={change}
            qaThreadId={qaThreadId}
            expanded={props.expandedChange === key}
            onToggle={() => props.onToggleChange(key)}
            onOpenThread={props.onOpenThread}
          />
        );
      })}
      <View className="flex-row justify-end px-1">
        <Button
          label="Open thread"
          icon="arrow.up.right"
          tone="text"
          accessibilityHint="Closes Evidence and opens the thread that shows this landing's QA"
          onPress={() => props.onOpenThread({ environmentId, threadId: qaThreadId })}
        />
      </View>
    </View>
  );
}

function ChangeRow(props: {
  readonly environmentId: EnvironmentId;
  readonly landing: EvidenceLanding;
  readonly change: QaChange;
  readonly qaThreadId: ThreadId;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (thread: InboxThreadTarget) => void;
}) {
  const { environmentId, landing, change } = props;
  // Discuss writes where web's card lives: the composer of the thread that shows this QA.
  const draftKey = scopedThreadKey(environmentId, props.qaThreadId);
  const inComposer = useQaKeysInComposer(draftKey).has(qaKey(landing.id, change.id));
  const status = qaCardStatus(change.qa, inComposer);
  const statusLabel =
    status === "open" && qaPresence(change.qa) === "quiet"
      ? qaNoted(change)
        ? "Noted"
        : "Nothing to check"
      : QA_STATUS_LABEL[status];
  const title = qaCardTitle(change);
  const ref = change.qa.ref === undefined ? null : qaRef(change);
  const waitsOnUser = change.qa.state === "pending";
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={`${ref === null ? "" : `${ref}: `}${title}, ${statusLabel}`}
        onPress={props.onToggle}
        className="min-h-11 flex-row items-start gap-2 rounded-xl px-2 py-2.5 active:bg-subtle"
      >
        {ref === null ? null : (
          <Text
            className={cn(
              "shrink-0 font-t3-bold text-sm tabular-nums",
              waitsOnUser ? "text-primary-text" : "text-foreground-muted",
            )}
          >
            {ref}
          </Text>
        )}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            selectable={props.expanded}
            numberOfLines={props.expanded ? undefined : 2}
            className="font-sans text-sm text-foreground"
          >
            {title}
          </Text>
          <Text
            className={cn(
              "font-sans text-xs",
              status === "agent-fixing" || status === "discussing"
                ? "text-warning-foreground"
                : "text-foreground-muted",
            )}
          >
            {statusLabel}
          </Text>
        </View>
        <SymbolView
          name={props.expanded ? "chevron.up" : "chevron.down"}
          size={11}
          tintColorClassName="accent-foreground-muted"
        />
      </Pressable>
      {props.expanded ? (
        <WaitingQaCard
          environmentId={environmentId}
          landing={landing}
          change={change}
          draftKey={draftKey}
          inComposer={inComposer}
          onDiscuss={() => props.onOpenThread({ environmentId, threadId: props.qaThreadId })}
        />
      ) : null}
    </View>
  );
}
