import { Link, useNavigate } from "@tanstack/react-router";
import { Settings2Icon } from "lucide-react";

import { StatusSourcesList, useStatusSignal } from "../components/statusSources/StatusSources";
import { Button } from "../components/ui/button";
import { MenuItemDetail } from "../components/ui/menu";

export function StatusView() {
  const { groups } = useStatusSignal();
  const navigate = useNavigate();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {groups.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">
          Connect to a server that supports status sources.
          <Button variant="ghost" size="xs" render={<Link to="/settings/status-sources" />}>
            <Settings2Icon /> Status source settings
          </Button>
        </p>
      ) : (
        <StatusSourcesList
          groups={groups}
          onConfigureSources={(machine) =>
            void navigate({ to: "/settings/status-sources", search: { machine } })
          }
        />
      )}
    </div>
  );
}

/** Sources failing or warning, from the status stream the titlebar toggle already reads. */
export function StatusAlertCount() {
  const { groups } = useStatusSignal();
  const count = groups
    .flatMap((group) => group.sources ?? [])
    .filter((source) => source.latest.state === "fail" || source.latest.state === "warn").length;
  return count === 0 ? null : <MenuItemDetail>{count}</MenuItemDetail>;
}
