import type { ReactNode } from "react";
import { View } from "react-native";

import { AndroidHeaderIconButton } from "../../components/ui/AndroidScreenHeader.android";
import { AppText as Text } from "../../components/ui/AppText";
import { WorkspaceAppBarScope } from "../../components/ui/WorkspaceAppBar.android";
import type { useInboxHeader } from "./useInboxHeader";

/** Android's app bar Inbox button, with the unread count over its icon. */
export function InboxAppBarButton(props: { readonly inbox: ReturnType<typeof useInboxHeader> }) {
  const { inbox } = props;
  return (
    <View>
      <AndroidHeaderIconButton
        accessibilityLabel={inbox.accessibilityLabel}
        icon="bell.badge"
        onPress={inbox.open}
      />
      {inbox.badge === null ? null : (
        <View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          className="absolute top-1 right-0.5 min-w-4.5 items-center rounded-full bg-primary px-1"
        >
          <Text className="font-t3-bold text-2xs text-primary-foreground tabular-nums">
            {inbox.badge}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * Mounts the inbox sheet outside the workspace bar's projection: inside it, the sheet's own bar
 * would replace the workspace bar and lose its Close control.
 */
export function InboxSheetOutsideWorkspaceBar(props: { readonly children: ReactNode }) {
  return <WorkspaceAppBarScope enabled={false}>{props.children}</WorkspaceAppBarScope>;
}
