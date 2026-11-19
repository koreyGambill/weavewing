import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentsPage } from "../components/settings/environments/EnvironmentsPage";

export const Route = createFileRoute("/_chat/settings/connections")({
  component: EnvironmentsPage,
});
