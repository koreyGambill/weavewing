import { createFileRoute } from "@tanstack/react-router";

import { ViewPageHost } from "../views/ViewPageHost";

function ViewPageRoute() {
  const { viewId } = Route.useParams();
  return <ViewPageHost key={viewId} viewId={viewId} />;
}

export const Route = createFileRoute("/_chat/view/$viewId")({
  component: ViewPageRoute,
});
