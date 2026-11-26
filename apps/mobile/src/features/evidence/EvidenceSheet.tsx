import type { EnvironmentId, EvidenceListInput } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Sheet } from "../../components/ui/Sheet";
import { evidenceList } from "../../state/evidence";
import { useEnvironmentQuery } from "../../state/query";
import type { InboxThreadTarget } from "../inbox/inbox.logic";
import { createInboxDismissal } from "../inbox/inboxDismissal";
import {
  evidenceEnvironmentHeading,
  evidenceSheetState,
  threadsWaitingPhrase,
  type EvidenceEnvironment,
  type EvidenceGroup,
} from "./evidence.logic";
import { EvidenceLandingCard } from "./EvidenceLandingCard";
import {
  ALL_LANDINGS_INPUT,
  NEEDS_QA_INPUT,
  useEvidenceFirstPages,
} from "./useEvidenceEnvironments";

/**
 * Landed work across every connected environment's threads, newest first: what needs QA, then
 * every landing, web's two Evidence filters one above the other. Only the newest landing that
 * needs QA opens by itself, so the sheet reads one landing's changes until the user opens more.
 * Mounted only while open.
 */
export function EvidenceSheet(props: {
  readonly environments: ReadonlyArray<EvidenceEnvironment>;
  /** Threads with changes waiting on the user, from the threads' exact counts. */
  readonly threadsWaiting: number;
  /** Runs once the sheet is gone, with the thread to open when the user asked for one. */
  readonly onClose: (thread: InboxThreadTarget | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const [expandedChange, setExpandedChange] = useState<string | null>(null);
  // Navigation waits for the dismissal, so the thread never opens under a closing sheet.
  const [leavingTo, setLeavingTo] = useState<InboxThreadTarget | null>(null);
  const [dismissal] = useState(createInboxDismissal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the dismissal fallback timer when the sheet unmounts
  useEffect(() => dismissal.dispose, [dismissal]);
  const leave = (thread: InboxThreadTarget) => {
    setLeavingTo(thread);
    dismissal.arm(() => props.onClose(thread));
  };
  const firstPages = useEvidenceFirstPages(props.environments);
  const state = evidenceSheetState(firstPages);
  const groupProps = {
    environments: props.environments,
    // The newest landing that needs QA in the first environment that has one.
    openEnvironmentId:
      props.environments[firstPages.findIndex((pages) => (pages.needsQa?.items.length ?? 0) > 0)]
        ?.environmentId ?? null,
    expandedChange,
    onToggleChange: (key: string) => setExpandedChange(expandedChange === key ? null : key),
    onOpenThread: leave,
  };

  return (
    <Sheet
      title="Evidence"
      open={leavingTo === null}
      onClose={() => dismissal.complete(() => props.onClose(leavingTo))}
    >
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
        {state.kind === "loading" ? (
          <Text className="px-1 font-sans text-sm text-foreground-secondary">
            Loading evidence…
          </Text>
        ) : state.kind === "empty" ? (
          <EmptyState
            variant="plain"
            title="No landings yet"
            detail="After each land, the lead records what changed with evidence_record. It shows here for your QA."
          />
        ) : (
          <>
            <GroupHeading title="Needs QA" detail={threadsWaitingPhrase(props.threadsWaiting)} />
            {state.needsQaEmpty ? (
              <Text className="px-1 font-sans text-sm text-foreground-secondary">
                Nothing waiting for your QA.
              </Text>
            ) : (
              <EvidenceGroupLists group="needs-qa" {...groupProps} />
            )}
            {state.allEmpty ? null : (
              <>
                <GroupHeading title="All landings" detail={null} />
                <EvidenceGroupLists group="all" {...groupProps} />
              </>
            )}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function GroupHeading(props: { readonly title: string; readonly detail: string | null }) {
  return (
    <View className="flex-row items-baseline gap-2 px-1 pt-2">
      <Text accessibilityRole="header" className="font-t3-bold text-base text-foreground">
        {props.title}
      </Text>
      {props.detail === null ? null : (
        <Text className="font-sans text-xs text-foreground-muted">{props.detail}</Text>
      )}
    </View>
  );
}

interface GroupListProps {
  readonly environments: ReadonlyArray<EvidenceEnvironment>;
  /** The environment whose first Needs QA landing opens by itself. */
  readonly openEnvironmentId: EnvironmentId | null;
  readonly expandedChange: string | null;
  readonly onToggleChange: (key: string) => void;
  readonly onOpenThread: (thread: InboxThreadTarget) => void;
}

/** One group's landings per environment, under the environment's name when there are several. */
function EvidenceGroupLists(props: GroupListProps & { readonly group: EvidenceGroup }) {
  const { environments, group, openEnvironmentId, expandedChange, onToggleChange, onOpenThread } =
    props;
  // A landing that needs QA lists in both groups, so each group opens its own copy of a card.
  const prefix = `${group}|`;
  const rest = {
    expandedChange: expandedChange?.startsWith(prefix) ? expandedChange.slice(prefix.length) : null,
    onToggleChange: (key: string) => onToggleChange(prefix + key),
    onOpenThread,
  };
  return environments.map((environment) => {
    const heading = evidenceEnvironmentHeading(environment, environments.length);
    return (
      <View key={environment.environmentId} className="gap-2">
        {heading === null ? null : (
          <Text className="px-1 font-t3-bold text-xs text-foreground-muted">{heading}</Text>
        )}
        <LandingPage
          {...rest}
          environmentId={environment.environmentId}
          input={group === "needs-qa" ? NEEDS_QA_INPUT : ALL_LANDINGS_INPUT}
          group={group}
          first
          labelled={heading !== null}
          openFirst={group === "needs-qa" && environment.environmentId === openEnvironmentId}
        />
      </View>
    );
  });
}

/** One page of landings; "Load older landings" chains the next page from this page's cursor. */
function LandingPage(
  props: Omit<GroupListProps, "environments" | "openEnvironmentId"> & {
    readonly environmentId: EnvironmentId;
    readonly input: EvidenceListInput;
    readonly group: EvidenceGroup;
    readonly first: boolean;
    /** Several environments are listed, so an empty one says so under its name. */
    readonly labelled: boolean;
    /** Opens this page's first landing, the newest that needs QA in the sheet. */
    readonly openFirst: boolean;
  },
) {
  const [more, setMore] = useState(false);
  const page = useEnvironmentQuery(
    evidenceList({ environmentId: props.environmentId, input: props.input }),
  );
  if (page.data === null)
    return page.error === null ? (
      <Text className="px-1 font-sans text-sm text-foreground-secondary">Loading evidence…</Text>
    ) : (
      <View className="gap-2 px-1">
        <Text selectable className="font-sans text-sm text-danger-foreground">
          Could not load evidence: {page.error}
        </Text>
        <Button label="Try again" onPress={page.refresh} />
      </View>
    );
  const shown = page.data.items;
  const next = page.data.next;
  return (
    <>
      {props.first && props.labelled && shown.length === 0 && next === null ? (
        <Text className="px-1 font-sans text-sm text-foreground-secondary">
          {props.group === "needs-qa" ? "Nothing waiting for your QA." : "No landings yet."}
        </Text>
      ) : null}
      {shown.map((landing, index) => (
        <EvidenceLandingCard
          key={landing.id}
          environmentId={props.environmentId}
          landing={landing}
          defaultOpen={props.openFirst && index === 0}
          expandedChange={props.expandedChange}
          onToggleChange={props.onToggleChange}
          onOpenThread={props.onOpenThread}
        />
      ))}
      {next === null ? null : more ? (
        <LandingPage
          {...props}
          input={{ ...props.input, before: next }}
          first={false}
          openFirst={false}
        />
      ) : (
        <View className="items-start px-1">
          <Button label="Load older landings" tone="text" onPress={() => setMore(true)} />
        </View>
      )}
    </>
  );
}
