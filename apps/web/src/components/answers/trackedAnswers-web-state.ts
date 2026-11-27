import { useAtomValue } from "@effect/atom-react";
import { WS_METHODS, type ScopedThreadRef, type ThreadUpdateAskInput } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";
export { useThreadTrackedAsks as useTrackedAsks } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const threadUpdateAsk = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "answer:update",
  tag: WS_METHODS.threadUpdateAsk,
});

export function useUpdateTrackedAsk(threadRef: ScopedThreadRef) {
  const update = useAtomCommand(threadUpdateAsk, { label: "Tracked answer" });
  const canUpdate = useAtomValue(threadUpdateAsk.permissionAtom(threadRef.environmentId));
  const submit = async (input: ThreadUpdateAskInput) =>
    (
      await update({
        environmentId: threadRef.environmentId,
        input,
      })
    )._tag === "Success";
  return { canUpdate, submit };
}
