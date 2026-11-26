import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  resolveEnvironmentMachineKind,
  type StatusItem,
  type StatusSource,
} from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useDeadlinePassed } from "../../lib/clock";
import { useEnvironmentsWithScope } from "../../state/session";
import { statusSourcesForEnvironments } from "../../state/status-sources";
import { useSettingsEnvironmentMenu } from "../settings/components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  useSettingsEnvironmentFilter,
  type SettingsTarget,
} from "../settings/settings-environment-filter";
import {
  statusEnvironmentResult,
  statusScreenView,
  statusSourceHeldSince,
  statusStatePresentation,
  type StatusEnvironmentGroup,
} from "./statusSources.logic";

const CONFIGURE_HINT =
  "Add checks in Settings › Status sources in the web or desktop app. They appear here once a server runs them.";

export function SettingsStatusSourcesRouteScreen() {
  const insets = useSafeAreaInsets();
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const permitted = useEnvironmentsWithScope(selectedTargets, AuthOrchestrationReadScope);
  const environments = selectedTargets.map((target) => ({
    environmentId: target.environmentId,
    label: target.label,
    readable:
      target.serverConfig.environment.capabilities.statusSources === true &&
      permitted.has(target.environmentId),
  }));
  const readableIds = environments
    .filter((environment) => environment.readable)
    .map((environment) => environment.environmentId);
  const results = useAtomValue(statusSourcesForEnvironments(readableIds.join("\n")));
  const view = statusScreenView(environments, results.map(statusEnvironmentResult));
  const targetsById = new Map(selectedTargets.map((target) => [target.environmentId, target]));

  return (
    <SettingsScreen title="Status" menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {view.kind === "no-environments" ? (
          <EmptyState
            title="No environment connected"
            detail="Connect an environment to see the health of its status checks."
          />
        ) : view.kind === "unsupported" ? (
          <EmptyState
            title="Status checks unavailable"
            detail="The connected servers don't share status checks with this device. Update a server that predates status sources."
          />
        ) : view.kind === "no-sources" ? (
          <EmptyState title="No status checks yet" detail={CONFIGURE_HINT} />
        ) : (
          view.groups.map((group) => (
            <EnvironmentStatusSection
              key={group.environmentId}
              group={group}
              target={
                view.showEnvironmentHeaders ? targetsById.get(group.environmentId) : undefined
              }
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentStatusSection(props: {
  readonly group: StatusEnvironmentGroup;
  /** Set when the page shows more than one environment, to head its checks. */
  readonly target: SettingsTarget | undefined;
}) {
  const { group, target } = props;
  return (
    <SettingsSection
      title={target ? group.label : undefined}
      titleIcon={
        target ? (
          <EnvironmentMachineSymbol
            kind={resolveEnvironmentMachineKind(target.serverConfig)}
            size={16}
            tintColorClassName={
              Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
            }
          />
        ) : undefined
      }
    >
      {group.result.kind === "loading" ? (
        <Text className="p-4 text-base text-foreground-muted">Loading checks…</Text>
      ) : group.result.kind === "failed" ? (
        <Text accessibilityRole="alert" className="p-4 text-base text-danger-foreground">
          {group.result.message}
        </Text>
      ) : group.result.sources.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          No status checks on this server.
        </Text>
      ) : (
        group.result.sources.map((source, index) => (
          <StatusSourceRow key={source.config.id} source={source} first={index === 0} />
        ))
      )}
    </SettingsSection>
  );
}

function StatusSourceRow(props: { readonly source: StatusSource; readonly first: boolean }) {
  const { source } = props;
  const [expanded, setExpanded] = useState(false);
  const state = statusStatePresentation(source.latest.state);
  const heldSince = statusSourceHeldSince(source);
  const snoozeEndsAt =
    source.config.snoozedUntil === null ? null : Date.parse(source.config.snoozedUntil);
  const snoozeEnded = useDeadlinePassed(snoozeEndsAt);
  const snoozedUntil = snoozeEnded ? null : source.config.snoozedUntil;
  return (
    <View className={props.first ? "" : "border-t border-border-subtle"}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${source.config.name}, ${state.label}`}
        accessibilityHint={expanded ? "Hides details" : "Shows details"}
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-start gap-3 px-4 py-3 active:opacity-70"
      >
        <View className="pt-0.5">
          <SymbolView
            name={state.symbol}
            size={18}
            tintColorClassName={state.tintColorClassName}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            textRole="body"
            className="text-foreground"
            numberOfLines={expanded ? undefined : 1}
          >
            {source.config.name}
          </Text>
          <Text className={`text-sm ${state.textClassName}`} numberOfLines={1}>
            {state.label}
            {heldSince ? (
              <>
                {" for "}
                <RelativeTime timestamp={heldSince} />
              </>
            ) : null}
            {source.origin ? (
              <Text className="text-sm text-foreground-muted">{` · From ${source.origin.label}`}</Text>
            ) : null}
          </Text>
          {source.latest.summary ? (
            <Text
              selectable={expanded}
              className="text-sm text-foreground-muted"
              numberOfLines={expanded ? undefined : 1}
            >
              {source.latest.summary}
            </Text>
          ) : null}
        </View>
        <View className="pt-1">
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </View>
      </Pressable>
      {expanded ? (
        <View className="gap-3 pb-3 pl-[46px] pr-4">
          {source.latest.items.length > 0 ? (
            <View className="gap-2">
              {source.latest.items.map((item) => (
                <StatusCheckRow key={item.name} item={item} />
              ))}
            </View>
          ) : null}
          {source.lastTransition ? (
            <Text selectable className="text-sm text-foreground-muted">
              {`Changed from ${statusStatePresentation(source.lastTransition.from).label} to ${statusStatePresentation(source.lastTransition.to).label} on ${new Date(source.lastTransition.at).toLocaleString()}`}
            </Text>
          ) : null}
          {snoozedUntil ? (
            <Text className="text-sm text-foreground-muted">
              {`Notifications snoozed until ${new Date(snoozedUntil).toLocaleString()}`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function StatusCheckRow(props: { readonly item: StatusItem }) {
  const state = statusStatePresentation(props.item.state);
  return (
    <View
      accessible
      accessibilityLabel={`${props.item.name}, ${state.label}${props.item.detail ? `: ${props.item.detail}` : ""}`}
      className="flex-row items-start gap-2"
    >
      <View className="pt-0.5">
        <SymbolView
          name={state.symbol}
          size={14}
          tintColorClassName={state.tintColorClassName}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm text-foreground">{props.item.name}</Text>
        {props.item.detail ? (
          <Text selectable className="text-sm text-foreground-muted">
            {props.item.detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
