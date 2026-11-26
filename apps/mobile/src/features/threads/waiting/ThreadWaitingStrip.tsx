import type {
  EvidenceLanding,
  EvidenceThreadResult,
  ScopedThreadRef,
  WaitingItemKind,
  WaitingItemSummary,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Sheet } from "../../../components/ui/Sheet";
import { cn } from "../../../lib/cn";
import { useThreadShell } from "../../../state/entities";
import { evidenceThread } from "../../../state/evidence";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../../state/query";
import {
  QA_STATUS_LABEL,
  findQaChange,
  qaCardStatus,
  qaCardTitle,
  qaHistory,
  qaHistoryCapped,
  qaRef,
  qaShowsCard,
  type QaChange,
} from "./qaCard.logic";
import { useQaKeysInComposer } from "./qaDiscuss";
import { WaitingQaCard } from "./WaitingQaCard";
import {
  WAITING_KIND_HEADING,
  WAITING_KIND_LABEL,
  groupWaitingRows,
  qaKeyParts,
  waitingRowNote,
  waitingSummary,
  withQuestionRows,
} from "./waitingStrip.logic";

export const WAITING_KIND_SYMBOL: Record<WaitingItemKind, AppSymbolName> = {
  question: "questionmark.bubble",
  qa: "checkmark.circle",
  task: "list.number",
};

interface WaitingSheetProps {
  readonly threadRef: ScopedThreadRef;
  readonly draftKey: string | null;
  /** Whether the environment records evidence, so QA rows can read their cards. */
  readonly evidenceSupported: boolean;
  /** Every open and deferred question the client has loaded, listed in place of the capped rows'. */
  readonly questionRows?: ReadonlyArray<WaitingItemSummary>;
  /**
   * A question's card, shown in the sheet in place of the list; `onDone` closes the sheet. Without
   * it a question row only shows its full title.
   */
  readonly renderQuestion?: (questionId: string, onDone: () => void) => ReactNode;
  /** The thread's answered questions, listed first under History. */
  readonly questionHistory?: ReactNode;
}

type RenderQaCard = (landing: EvidenceLanding, change: QaChange, key: string) => ReactNode;

/**
 * The compact "Waiting on you" row above the composer, shown only while something waits, with
 * per-kind counts from the thread's exact counts. It and the header's "Waiting and history"
 * entry open the same sheet, whose open state the thread screen owns.
 */
export function ThreadWaitingStrip(
  props: WaitingSheetProps & {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  },
) {
  const shell = useThreadShell(props.threadRef);
  const rows = withQuestionRows(shell?.waiting, props.questionRows);
  const summary = waitingSummary(rows, shell?.waitingCounts);
  const spoken =
    summary === null
      ? ""
      : [
          ...summary.counts.map(
            ({ kind, count }) =>
              `${count} ${count === 1 ? WAITING_KIND_LABEL[kind].one : WAITING_KIND_LABEL[kind].many}`,
          ),
          ...(summary.discussing > 0 ? [`${summary.discussing} discussing`] : []),
        ].join(", ");
  return (
    <>
      {summary === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Waiting on you: ${spoken}`}
          accessibilityHint="Lists what is waiting and what you answered"
          onPress={() => props.onOpenChange(true)}
          className={cn(
            "min-h-11 flex-row items-center gap-2 px-4 py-2 active:opacity-70",
            Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
          )}
        >
          <SymbolView name="person.badge.clock" size={13} tintColorClassName="accent-foreground" />
          <Text className="font-t3-medium text-xs text-foreground">Waiting on you</Text>
          {summary.counts.map(({ kind, count }) => (
            <View key={kind} className="flex-row items-center gap-0.5">
              <SymbolView
                name={WAITING_KIND_SYMBOL[kind]}
                size={12}
                tintColorClassName="accent-foreground-muted"
              />
              <Text className="text-xs tabular-nums text-foreground-muted">{count}</Text>
            </View>
          ))}
          {summary.discussing > 0 ? (
            <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
              · {summary.discussing} discussing
            </Text>
          ) : null}
          <View className="flex-1" />
          <SymbolView name="chevron.up" size={11} tintColorClassName="accent-foreground-muted" />
        </Pressable>
      )}
      {props.open ? (
        <WaitingSheet
          {...props}
          rows={rows}
          unlisted={summary?.unlisted ?? 0}
          onClose={() => props.onOpenChange(false)}
        />
      ) : null}
    </>
  );
}

/** Mounted only while open, so its evidence read ends when it closes or the thread changes. */
function WaitingSheet(
  props: WaitingSheetProps & {
    readonly rows: ReadonlyArray<WaitingItemSummary> | undefined;
    readonly unlisted: number;
    readonly onClose: () => void;
  },
) {
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState<string | null>(null);
  // The question whose card the sheet shows in place of the list, opened from its row.
  const [question, setQuestion] = useState<string | null>(null);
  const groups = groupWaitingRows(props.rows);
  const listedQa = new Set(
    groups.flatMap((group) => group.items.flatMap((row) => (row.kind === "qa" ? [row.key] : []))),
  );
  const landingIds = [
    ...new Set([...listedQa].flatMap((key) => qaKeyParts(key)?.landingId ?? [])),
  ].sort();
  const evidence = useEnvironmentQuery<EvidenceThreadResult, unknown>(
    props.evidenceSupported
      ? evidenceThread({
          environmentId: props.threadRef.environmentId,
          input: {
            threadId: props.threadRef.threadId,
            ...(landingIds.length === 0 ? {} : { landingIds }),
          },
        })
      : null,
  );
  const inComposer = useQaKeysInComposer(props.draftKey);
  const history = evidence.data === null ? [] : qaHistory(evidence.data.landings, listedQa);
  const toggle = (id: string) => setExpanded(expanded === id ? null : id);
  const renderCard: RenderQaCard = (landing, change, key) => (
    <WaitingQaCard
      environmentId={props.threadRef.environmentId}
      landing={landing}
      change={change}
      draftKey={props.draftKey}
      inComposer={inComposer.has(key)}
      onDiscuss={props.onClose}
    />
  );

  if (question !== null && props.renderQuestion !== undefined) {
    return (
      <Sheet title={question} onClose={props.onClose}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            gap: 12,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: Math.max(20, insets.bottom),
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to waiting and history"
            onPress={() => setQuestion(null)}
            className="min-h-11 flex-row items-center gap-1.5 self-start rounded-xl px-2 active:bg-subtle"
          >
            <SymbolView name="chevron.left" size={13} tintColorClassName="accent-primary-text" />
            <Text className="font-t3-medium text-sm text-primary-text">Waiting and history</Text>
          </Pressable>
          {props.renderQuestion(question, props.onClose)}
        </ScrollView>
      </Sheet>
    );
  }

  return (
    <Sheet title="Waiting and history" onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: Math.max(20, insets.bottom),
        }}
      >
        <Text className="px-1 font-t3-bold text-base text-foreground">Waiting on you</Text>
        {groups.length === 0 ? (
          <Text className="px-1 font-sans text-sm text-foreground-secondary">
            Nothing is waiting on you in this thread.
          </Text>
        ) : null}
        {groups.map((group) => (
          <View key={group.kind} className="gap-1">
            <Text className="px-1 font-t3-bold text-xs text-foreground-muted">
              {WAITING_KIND_HEADING[group.kind]}
            </Text>
            {group.items.map((row) => {
              const id = `${row.kind}:${row.key}`;
              const isOpen = expanded === id;
              return (
                <View key={id} className="gap-2">
                  <WaitingRow
                    kind={row.kind}
                    refLabel={row.ref}
                    title={row.title}
                    note={waitingRowNote(row)}
                    noteWarns
                    highlighted={row.state === "open" && row.sent !== true}
                    expanded={isOpen}
                    onPress={() => {
                      if (row.kind === "question" && props.renderQuestion !== undefined)
                        setQuestion(row.key);
                      else toggle(id);
                    }}
                  />
                  {isOpen && row.kind === "qa" ? (
                    <WaitingQaSlot
                      evidenceSupported={props.evidenceSupported}
                      rowKey={row.key}
                      evidence={evidence}
                      renderCard={renderCard}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
        {props.unlisted > 0 ? (
          <Text className="px-1 font-sans text-xs text-foreground-muted">
            {props.unlisted} more not listed here. See them on web or desktop.
          </Text>
        ) : null}

        <Text className="px-1 pt-2 font-t3-bold text-base text-foreground">History</Text>
        {props.questionHistory}
        {!props.evidenceSupported ? null : evidence.error !== null ? (
          <EvidenceError message={evidence.error} onRetry={evidence.refresh} />
        ) : evidence.data === null ? (
          <Text className="px-1 font-sans text-sm text-foreground-secondary">Loading…</Text>
        ) : history.length === 0 ? (
          <Text className="px-1 font-sans text-sm text-foreground-secondary">
            No answered changes in this thread yet.
          </Text>
        ) : (
          <View className="gap-1">
            <Text className="px-1 font-t3-bold text-xs text-foreground-muted">QA</Text>
            {history.map((entry) => {
              // The same id as its waiting row, so a card the user just settled stays open here.
              const id = `qa:${entry.key}`;
              const isOpen = expanded === id;
              const status = qaCardStatus(entry.change.qa, false);
              return (
                <View key={id} className="gap-2">
                  <WaitingRow
                    kind="qa"
                    refLabel={qaRef(entry.change)}
                    title={qaCardTitle(entry.change)}
                    note={QA_STATUS_LABEL[status]}
                    noteWarns={status === "agent-fixing"}
                    highlighted={false}
                    expanded={isOpen}
                    onPress={() => toggle(id)}
                  />
                  {isOpen ? renderCard(entry.landing, entry.change, entry.key) : null}
                </View>
              );
            })}
          </View>
        )}
        {evidence.data !== null && qaHistoryCapped(evidence.data.landings) ? (
          <Text className="px-1 font-sans text-xs text-foreground-muted">
            Older QA is on web or desktop.
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function WaitingRow(props: {
  readonly kind: WaitingItemKind;
  readonly refLabel: string;
  readonly title: string;
  readonly note: string | null;
  readonly noteWarns: boolean;
  /** The row waits on the user, so its ref takes the accent. */
  readonly highlighted: boolean;
  readonly expanded: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.refLabel}: ${props.title}${props.note === null ? "" : `, ${props.note}`}`}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onPress}
      className="min-h-11 flex-row items-start gap-2 rounded-xl px-2 py-2.5 active:bg-subtle"
    >
      <SymbolView
        name={WAITING_KIND_SYMBOL[props.kind]}
        size={14}
        tintColorClassName="accent-foreground-muted"
      />
      <Text
        className={cn(
          "shrink-0 font-t3-bold text-sm tabular-nums",
          props.highlighted ? "text-primary-text" : "text-foreground-muted",
        )}
      >
        {props.refLabel}
      </Text>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          selectable={props.expanded}
          className="font-sans text-sm text-foreground"
          numberOfLines={props.expanded ? undefined : 2}
        >
          {props.title}
        </Text>
        {props.note === null ? null : (
          <Text
            className={cn(
              "font-sans text-xs",
              props.noteWarns ? "text-warning-foreground" : "text-foreground-muted",
            )}
          >
            {props.note}
          </Text>
        )}
      </View>
      <SymbolView
        name={props.expanded ? "chevron.up" : "chevron.down"}
        size={11}
        tintColorClassName="accent-foreground-muted"
      />
    </Pressable>
  );
}

function EvidenceError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <View className="gap-2 px-1">
      <Text selectable className="font-sans text-sm text-danger-foreground">
        Could not load QA: {props.message}
      </Text>
      <Button label="Try again" size="compact" onPress={props.onRetry} />
    </View>
  );
}

/** A waiting QA row's card, once the thread's landings have it. */
function WaitingQaSlot(props: {
  readonly evidenceSupported: boolean;
  readonly rowKey: string;
  readonly evidence: EnvironmentQueryView<EvidenceThreadResult>;
  readonly renderCard: RenderQaCard;
}) {
  if (!props.evidenceSupported)
    return <SlotNote text="This environment does not record evidence." />;
  if (props.evidence.error !== null)
    return <EvidenceError message={props.evidence.error} onRetry={props.evidence.refresh} />;
  const parts = qaKeyParts(props.rowKey);
  const found =
    parts === null || props.evidence.data === null
      ? null
      : findQaChange(props.evidence.data.landings, parts);
  if (found === null)
    return (
      <SlotNote
        text={
          props.evidence.data === null
            ? "Loading…"
            : "This change is no longer in the thread's evidence."
        }
      />
    );
  if (!qaShowsCard(found.change.qa)) return <SlotNote text="Nothing to check for this change." />;
  return props.renderCard(found.landing, found.change, props.rowKey);
}

function SlotNote(props: { readonly text: string }) {
  return <Text className="px-2 font-sans text-sm text-foreground-secondary">{props.text}</Text>;
}
