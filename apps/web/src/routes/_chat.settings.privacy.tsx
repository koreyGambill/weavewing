// Weavewing: outbound choices share the existing connection controls.
import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

export const Route = createFileRoute("/_chat/settings/privacy")({
  component: ConnectionsSettings,
});
