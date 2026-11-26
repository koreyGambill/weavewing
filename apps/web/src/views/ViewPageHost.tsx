import { useNavigate, useRouter } from "@tanstack/react-router";
import { Maximize2, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";

import { readPullRequestListPreferences } from "../components/pullRequest/pullRequestListPreferences";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { observeResize } from "../lib/observeResize";
import { holdSideAreaThroughRoute, useToolSidebarStore } from "../toolSidebarStore";
import { resolveHostedViewLayout, resolveViewPage } from "./viewPage.logic";
import {
  VIEW_DEFINITIONS,
  type ViewDefinition,
  type ViewHost,
  type ViewLayout,
  type ViewSlots,
  type ViewTarget,
} from "./viewRegistry";

const GLOBAL_TARGET: ViewTarget = { threadRef: null, draft: null };

function navigateToViewPage(
  navigate: ReturnType<typeof useNavigate>,
  definition: ViewDefinition,
  replace = false,
) {
  switch (definition.page) {
    case "/pull-requests":
      return navigate({
        to: "/pull-requests",
        search: readPullRequestListPreferences(),
        replace,
      });
    case "/view/$viewId":
      return navigate({
        to: "/view/$viewId",
        params: { viewId: definition.id },
        replace,
      });
    case undefined:
      return Promise.resolve();
  }
}

/** Opens a global view's page; a view without one stays where it is. */
export function useOpenViewPage() {
  const navigate = useNavigate();
  return (definition: ViewDefinition) => navigateToViewPage(navigate, definition);
}

/**
 * A view inside a host of a given width. Narrower than the view's `minWidthPx`, the view renders
 * compact, with Open full size when it has a page.
 */
export function HostedView({
  definition,
  target,
  layout,
  host,
  width,
  slots,
  onOpenFullSize,
}: {
  definition: ViewDefinition;
  target: ViewTarget;
  layout: ViewLayout;
  host: ViewHost;
  width: number;
  slots: ViewSlots;
  /** Runs before the page opens, for a host that should close behind it. */
  onOpenFullSize?: () => void;
}) {
  const openViewPage = useOpenViewPage();
  const hosted = resolveHostedViewLayout(definition, { layout, width });
  return (
    <>
      {hosted.openFullSize ? (
        <div className="flex shrink-0 items-center gap-2 border-b py-1.5 ps-3 pe-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{definition.title} needs a wider space.</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              onOpenFullSize?.();
              void openViewPage(definition);
            }}
          >
            <Maximize2 />
            Open full size
          </Button>
        </div>
      ) : null}
      {definition.render({ target, layout: hosted.layout, host, width, slots })}
    </>
  );
}

function useGoBack() {
  const router = useRouter();
  const navigate = useNavigate();
  return () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/" });
  };
}

/** The full page for a global view, or a way back when the id names no such view. */
export function ViewPageHost({ viewId }: { viewId: string }) {
  const resolution = resolveViewPage(viewId, VIEW_DEFINITIONS);
  const navigate = useNavigate();
  const [focusHeading] = useState(() => (node: HTMLHeadingElement | null) => {
    node?.focus({ preventScroll: true });
  });

  const ownRoute = resolution.kind === "own-route" ? resolution.definition : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A view with a route of its own opens there, replacing this entry so back skips it.
  useEffect(() => {
    if (ownRoute) void navigateToViewPage(navigate, ownRoute, true);
  }, [navigate, ownRoute]);

  if (ownRoute) return null;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {resolution.kind === "page" ? (
          <ViewPageBody definition={resolution.definition} focusHeading={focusHeading} />
        ) : (
          <ViewPageNotFound
            title={resolution.kind === "thread-view" ? resolution.definition.title : null}
            focusHeading={focusHeading}
          />
        )}
      </div>
    </SidebarInset>
  );
}

function ViewPageHeading({
  title,
  focusHeading,
}: {
  title: string;
  focusHeading: (node: HTMLHeadingElement | null) => void;
}) {
  return (
    <WorkspaceBreadcrumb ariaLabel={`${title} page`}>
      <WorkspaceBreadcrumbItem current>
        <h1 ref={focusHeading} tabIndex={-1} className="truncate outline-none">
          {title}
        </h1>
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}

function ViewPageBody({
  definition,
  focusHeading,
}: {
  definition: ViewDefinition;
  focusHeading: (node: HTMLHeadingElement | null) => void;
}) {
  const goBack = useGoBack();
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [measure] = useState(() => (node: HTMLDivElement | null) => {
    if (!node) return;
    setWidth(node.clientWidth);
    return observeResize(node, () => setWidth(node.clientWidth));
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Leaving the page ends a hand-over to the side area; the release waits until the route change that unmounted it has run its effects.
  useEffect(() => () => void window.setTimeout(() => holdSideAreaThroughRoute(false), 0), []);

  const openInSidePanel = () => {
    useToolSidebarStore.getState().dispatch({ type: "show", view: definition.id });
    holdSideAreaThroughRoute(true);
    goBack();
  };
  const { layout } = resolveHostedViewLayout(definition, { layout: "full", width });

  return (
    <>
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <ViewPageHeading title={definition.title} focusHeading={focusHeading} />
        <div className="min-w-0 flex-1" />
        <div ref={setActions} className="flex min-w-0 items-center" />
        <Button size="sm" variant="ghost" onClick={openInSidePanel}>
          <PanelRight />
          Open in side panel
        </Button>
      </WorkspacePageHeader>
      <div ref={measure} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {width > 0
          ? definition.render({
              target: GLOBAL_TARGET,
              layout,
              host: "page",
              width,
              slots: { actions, setDetails: () => {} },
            })
          : null}
      </div>
    </>
  );
}

function ViewPageNotFound({
  title,
  focusHeading,
}: {
  /** The thread view the id names, if any. */
  title: string | null;
  focusHeading: (node: HTMLHeadingElement | null) => void;
}) {
  const goBack = useGoBack();
  return (
    <>
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <ViewPageHeading title="View not found" focusHeading={focusHeading} />
      </WorkspacePageHeader>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{title ? `${title} has no page` : "There is no view here"}</EmptyTitle>
          <EmptyDescription>
            {title
              ? `${title} shows one thread, so it opens in the side panel beside that thread.`
              : "This link names a view that does not exist or has no page."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={goBack}>
            Return to previous page
          </Button>
        </EmptyContent>
      </Empty>
    </>
  );
}
