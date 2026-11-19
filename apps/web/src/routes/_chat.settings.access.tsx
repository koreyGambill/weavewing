import { createFileRoute, redirect } from "@tanstack/react-router";

// Sharing & access moved onto Environments; old links and bookmarks still land there.
export const Route = createFileRoute("/_chat/settings/access")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/connections", hash: location.hash, replace: true });
  },
});
