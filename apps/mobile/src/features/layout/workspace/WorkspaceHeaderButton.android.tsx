import type { ReactNode } from "react";
import { View } from "react-native";

import { AndroidHeaderIconButton } from "../../../components/ui/AndroidScreenHeader.android";
import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { WorkspaceAppBarScope } from "../../../components/ui/WorkspaceAppBar.android";

/** One of the thread list's app bar entries, such as Inbox or Evidence, with its count over the icon. */
export function WorkspaceHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly badge: string | null;
  readonly onPress: () => void;
}) {
  return (
    <View>
      <AndroidHeaderIconButton
        accessibilityLabel={props.accessibilityLabel}
        icon={props.icon}
        onPress={props.onPress}
      />
      {props.badge === null ? null : (
        <View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          className="absolute top-1 right-0.5 min-w-4.5 items-center rounded-full bg-primary px-1"
        >
          <Text className="font-t3-bold text-2xs text-primary-foreground tabular-nums">
            {props.badge}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * Mounts the entries' sheets outside the workspace bar's projection: inside it, a sheet's own bar
 * would replace the workspace bar and lose its Close control.
 */
export function SheetsOutsideWorkspaceBar(props: { readonly children: ReactNode }) {
  return <WorkspaceAppBarScope enabled={false}>{props.children}</WorkspaceAppBarScope>;
}
