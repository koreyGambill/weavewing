import { createFileRoute } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";

import { AgentContextSettings } from "../components/settings/AgentContextSettings";

const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

function SettingsAgentContextRoute() {
  const search = Route.useSearch();
  return <AgentContextSettings {...search} />;
}

export const Route = createFileRoute("/_chat/settings/agent-context")({
  validateSearch: (raw: Record<string, unknown>) => {
    const provider = text(raw.provider);
    const projectId = text(raw.projectId);
    const source = text(raw.source);
    return {
      ...(provider === undefined ? {} : { provider }),
      ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
      ...(source === undefined ? {} : { source }),
    };
  },
  component: SettingsAgentContextRoute,
});
