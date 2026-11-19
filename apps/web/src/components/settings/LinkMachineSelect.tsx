import { type LinkableMachine, linkDestination } from "@t3tools/client-runtime/link-request";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";

/**
 * Shown wherever a link goes to an address this app does not already have for a
 * machine, with where that address leads.
 */
export function LinkAddressWarning({ address }: { readonly address: string }) {
  return (
    <Alert variant="warning">
      <AlertTitle>Check this address</AlertTitle>
      <AlertDescription>
        This app cannot confirm it is one of your machines. The pairing code you paste is sent
        there.
        <span className="block break-all">{linkDestination(address)}</span>
      </AlertDescription>
    </Alert>
  );
}

/** Whether a machine is linked already, or how this app knows it when not connected to it. */
export function LinkMachineBadge({ machine }: { readonly machine: LinkableMachine }) {
  if (machine.linked) {
    return (
      <Badge variant="success" size="sm">
        Linked
      </Badge>
    );
  }
  if (machine.connected) return null;
  return (
    <Badge variant="outline" size="sm">
      {machine.connectOnly ? "T3 Connect" : "Not connected"}
    </Badge>
  );
}
