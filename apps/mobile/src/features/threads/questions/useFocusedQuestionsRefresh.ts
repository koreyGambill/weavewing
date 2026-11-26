import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef } from "react";
import { AppState } from "react-native";

/**
 * Refetches the thread's questions when its screen gains focus again and when the app returns to
 * the foreground while it is focused, so a draft another client edited reaches the card; state
 * changes arrive through the waiting counts. The first focus skips the refetch, since the query
 * fetches on mount.
 */
export function useFocusedQuestionsRefresh(refresh: () => void) {
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedBefore.current) refresh();
      focusedBefore.current = true;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => subscription.remove();
    }, [refresh]),
  );
}
