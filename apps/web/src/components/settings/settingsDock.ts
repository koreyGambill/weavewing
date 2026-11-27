import { useMatches } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const SETTINGS_DOCKED_STORAGE_KEY = "t3code:settings-docked";
/** Below this width a docked pane would squeeze the chat beside it, so Settings stays a modal. */
const SETTINGS_DOCK_MEDIA_QUERY = "(min-width: 1024px)";

function isSettingsPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** The device's choice to show Settings docked beside the app instead of over it. */
export function useSettingsDockPreference() {
  return useLocalStorage(SETTINGS_DOCKED_STORAGE_KEY, false, Schema.Boolean);
}

/** Whether the window is wide enough to dock Settings. */
export function useSettingsDockAvailable() {
  return useMediaQuery(SETTINGS_DOCK_MEDIA_QUERY);
}

/** True while Settings is open and docked, so the app shell shares the window with it. */
export function useSettingsDocked() {
  const [docked] = useSettingsDockPreference();
  const available = useSettingsDockAvailable();
  const settingsOpen = useMatches({
    select: (matches) => matches.some((match) => isSettingsPage(match.pathname)),
  });
  return docked && available && settingsOpen;
}
