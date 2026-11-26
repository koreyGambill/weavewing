import { useEffect, useState } from "react";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import { BackHandler, Keyboard } from "react-native";

import { AppBar } from "../../../components/ui/AppBar";
import { useWorkspaceConnectionState } from "../../../state/workspace";
import { useHardwareKeyboardCommand } from "../../keyboard/hardwareKeyboardCommands";
import { WorkspaceBrandTitle } from "./WorkspaceBrandTitle";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import {
  workspaceListFilterIcon,
  type WorkspaceListHeaderProps,
} from "./WorkspaceListHeader.types";
import { APP_BASE_NAME } from "../../../lib/mobileBranding";
import { useEvidenceHeader } from "../../evidence/useEvidenceHeader";
import { useInboxHeader } from "../../inbox/useInboxHeader";
import { SheetsOutsideWorkspaceBar, WorkspaceHeaderButton } from "./WorkspaceHeaderButton.android";

export function WorkspaceListHeader(props: WorkspaceListHeaderProps) {
  const inbox = useInboxHeader();
  const evidence = useEvidenceHeader();
  return (
    <>
      <WorkspaceListAppBar {...props} inbox={inbox} evidence={evidence} />
      <SheetsOutsideWorkspaceBar>
        {inbox.sheet}
        {evidence.sheet}
      </SheetsOutsideWorkspaceBar>
    </>
  );
}

function WorkspaceListAppBar(
  props: WorkspaceListHeaderProps & {
    readonly inbox: ReturnType<typeof useInboxHeader>;
    readonly evidence: ReturnType<typeof useEvidenceHeader>;
  },
) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const isTabActive = workspace?.isTabActive;
  const homeFocused = useNavigationState((state) => state.routes[state.index]?.name === "Home");
  const listFocused =
    homeFocused && (workspace === null || workspace.state.selectedTab === "threads");
  const connectionState = useWorkspaceConnectionState();
  const { search, sidebar } = props;
  const onSearchQueryChange = search.onChangeText;
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || search.value.length > 0;
  const openSearch = () => {
    sidebar?.onRequestVisibility();
    setSearchOpen(true);
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = () => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to BackHandler while searching to close search on Android back
  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Frozen Home screens can keep effects alive after a detail route opens.
      const state = navigation.getState();
      if (
        !state ||
        state.routes[state.index]?.name !== "Home" ||
        isTabActive?.("threads") === false
      )
        return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching, listFocused, navigation, isTabActive]);

  return (
    <AppBar
      title={APP_BASE_NAME}
      titleContent={
        <WorkspaceBrandTitle
          accessibilityLabel={props.accessibilityLabel}
          onOpenEnvironments={props.onOpenEnvironments}
        />
      }
      search={{
        value: search.value,
        onChangeText: onSearchQueryChange,
        placeholder: search.placeholder,
        accessibilityLabel: search.accessibilityLabel,
        active: searching,
        onOpen: openSearch,
        onClose: closeSearch,
      }}
      menus={
        connectionState.hasConnections
          ? [
              {
                title: "Filter threads",
                icon: workspaceListFilterIcon(props.filter.customized),
                items: props.filter.items,
              },
            ]
          : undefined
      }
      // Evidence sits before Inbox, so Inbox keeps its place as Evidence shows and hides.
      trailing={
        connectionState.hasConnections
          ? [
              props.evidence.available ? (
                <WorkspaceHeaderButton
                  key="evidence"
                  accessibilityLabel={props.evidence.accessibilityLabel}
                  icon="checkmark.circle"
                  badge={props.evidence.badge}
                  onPress={props.evidence.open}
                />
              ) : null,
              <WorkspaceHeaderButton
                key="inbox"
                accessibilityLabel={props.inbox.accessibilityLabel}
                icon="bell.badge"
                badge={props.inbox.badge}
                onPress={props.inbox.open}
              />,
            ]
          : undefined
      }
    />
  );
}
