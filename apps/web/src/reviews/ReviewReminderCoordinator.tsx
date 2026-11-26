import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ReviewSummary,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useShallow } from "zustand/react/shallow";
import { useThreadContextSidebarStore } from "../threadContextSidebarStore";
import { useToolSidebarStore } from "../toolSidebarStore";
import { useEnvironments } from "../state/environments";
import { reviewArtifactsDue } from "../state/reviews";
import { useEnvironmentsWithScope } from "../state/session";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  threadNotificationTag,
} from "../threadNotifications";
import { createReviewReminderGate } from "./ReviewReminderCoordinator.logic";

const EMPTY_REVIEWS: ReadonlyArray<ReviewSummary> = [];

export function ReviewReminderCoordinator() {
  const { environments } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const [seen] = useState(() => new Set<string>());
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.reviewArtifacts === true &&
        readable.has(environment.environmentId),
    )
    .map(({ environmentId }) => (
      <EnvironmentReviewReminders key={environmentId} environmentId={environmentId} seen={seen} />
    ));
}

function EnvironmentReviewReminders({
  environmentId,
  seen,
}: {
  environmentId: EnvironmentId;
  seen: Set<string>;
}) {
  const due = useAtomValue(reviewArtifactsDue({ environmentId, input: {} }), (result) =>
    AsyncResult.getOrElse(result, () => EMPTY_REVIEWS),
  );
  const settings = useClientSettings();
  const navigate = useNavigate();
  const active = useParams({ strict: false });
  const artifactSelection = useThreadContextSidebarStore((state) => state.artifactSelection);
  const side = useToolSidebarStore(
    useShallow(({ open, view, locked }) => ({ open, view, locked })),
  );
  const [gate] = useState(() => createReviewReminderGate(environmentId, seen));
  const shownReviewId = due.find(
    (review) =>
      active.environmentId === environmentId &&
      active.threadId === review.threadId &&
      side.open &&
      side.view === "artifacts" &&
      artifactSelection?.id === review.id &&
      (artifactSelection.thread === null ||
        artifactSelection.thread.threadId === review.threadId) &&
      (side.locked === null || side.locked.threadId === review.threadId),
  )?.id;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes and closes imperative notification surfaces as persisted reminders become due or change
  useEffect(() => {
    let active = true;
    const sync = () => {
      if (!active) return;
      const looking = document.visibilityState === "visible" && document.hasFocus();
      gate.sync(due, looking ? shownReviewId : undefined, (review) => {
        const { notificationMode, inAppNotificationsEnabled } = settings;
        const open = () => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: review.threadId },
          });
          useThreadContextSidebarStore.getState().show("artifacts", {
            thread: scopeThreadRef(environmentId, review.threadId),
            artifactId: review.id,
          });
        };
        let dismiss: (() => void) | undefined;
        if (looking && inAppNotificationsEnabled) {
          const toastId = toastManager.add({
            type: "info",
            title: "Review reminder",
            description: review.title,
            data: { hideCopyButton: true },
            actionProps: {
              children: "Open review",
              onClick: () => {
                toastManager.close(toastId);
                open();
              },
            },
          });
          dismiss = () => toastManager.close(toastId);
        } else if (
          !looking &&
          hasDesktopNotifications(notificationMode) &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          try {
            const notification = new Notification("Review reminder", {
              body: review.title,
              tag: `review:${threadNotificationTag(environmentId, review.threadId)}:${review.id}`,
              silent: true,
            });
            notification.addEventListener("click", () => {
              notification.close();
              window.focus();
              open();
            });
            dismiss = () => notification.close();
          } catch {
            // Some browsers expose Notification but reject desktop presentation.
          }
        }
        if (hasNotificationSound(notificationMode)) {
          void playNotificationSound("input", () =>
            hasNotificationSound(getClientSettings().notificationMode),
          );
          if (dismiss === undefined) dismiss = () => {};
        }
        return dismiss;
      });
    };
    // StrictMode replays effect setup before this queued publication can escape its cleanup.
    queueMicrotask(sync);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [due, environmentId, gate, navigate, settings, shownReviewId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears native notifications and toasts on unmount or when notification preferences change
  useEffect(() => {
    if (settings.notificationMode === "off" && !settings.inAppNotificationsEnabled) gate.dispose();
    return () => gate.dispose();
  }, [gate, settings.notificationMode, settings.inAppNotificationsEnabled]);
  return null;
}
