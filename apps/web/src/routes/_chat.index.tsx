import { workspaceAreaProps } from "../lib/workspaceFocus";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../env";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { Button } from "../components/ui/button";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useScratchProject } from "../hooks/useScratchProject";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexDraftLanding />;
}

function IndexDraftLanding() {
  // The default place reads projects when asked; subscribing re-renders as they load.
  useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const router = useRouter();
  // Read at effect time; this page can stay mounted while the router is already navigating away.
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startedAttemptRef = useRef<number | null>(null);
  const [startState, setStartState] = useState({ failed: false, retryRequest: 0 });
  const scratch = useScratchProject();
  // The same resolver and notice as New thread, so the start page never falls back silently.
  const hasStartTarget = scratch.defaultPlace(null).kind !== "none";
  const attempt = startState.retryRequest;
  const startDraft = useEffectEvent(() => scratch.startDefaultPlace(null, { replace: true }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts a draft thread in the default place and navigates to it while still on the index
  useEffect(() => {
    // Starting a draft after the user has left would replace the page they picked.
    if (!hasStartTarget || startedAttemptRef.current === attempt || !isStillOnIndex()) {
      return;
    }
    startedAttemptRef.current = attempt;
    void startDraft().then((opened) => {
      if (!opened) setStartState((state) => ({ ...state, failed: true }));
    });
  }, [attempt, hasStartTarget]);

  if (hasStartTarget) {
    return startState.failed ? (
      <DraftStartError
        onRetry={() => {
          setStartState((state) => ({
            failed: false,
            retryRequest: state.retryRequest + 1,
          }));
        }}
      />
    ) : null;
  }
  // A pending environment cannot prove the workspace is empty.
  return bootstrapped ? <NoProjectsHero /> : null;
}

function DraftStartError({ onRetry }: { readonly onRetry: () => void }) {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>Couldn’t start a new thread</EmptyTitle>
          <EmptyDescription>
            The project is still available. Try opening the draft again.
          </EmptyDescription>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={onRetry}>
              <RefreshIcon size="md" />
              Try again
            </Button>
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
