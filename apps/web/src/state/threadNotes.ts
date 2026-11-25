import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type {
  ThreadNotesGetInput,
  ThreadNotesSaveImageInput,
  ThreadNotesSaveInput,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const threadNoteGet = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadNotes:get",
  tag: WS_METHODS.threadNotesGet,
  staleTimeMs: 5_000,
  refreshIntervalMs: 5_000,
  idleTtlMs: 0,
});
export const threadNotesSettings = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "threadNotes:settings",
  tag: WS_METHODS.threadNotesSettings,
  staleTimeMs: 30_000,
  idleTtlMs: 0,
});
const get = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "threadNotes:getOnce",
  tag: WS_METHODS.threadNotesGet,
});
export async function fetchThreadNote(environmentId: EnvironmentId, input: ThreadNotesGetInput) {
  const result = await runAtomCommand(appAtomRegistry, get, { environmentId, input });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
const save = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "threadNotes:save",
  tag: WS_METHODS.threadNotesSave,
});
export const updateThreadNotesSettings = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "threadNotes:updateSettings",
  tag: WS_METHODS.threadNotesUpdateSettings,
});
export async function persistThreadNote(environmentId: EnvironmentId, input: ThreadNotesSaveInput) {
  const result = await runAtomCommand(appAtomRegistry, save, { environmentId, input });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
const saveImage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "threadNotes:saveImage",
  tag: WS_METHODS.threadNotesSaveImage,
});
export async function saveThreadNoteImage(
  environmentId: EnvironmentId,
  input: ThreadNotesSaveImageInput,
) {
  const result = await runAtomCommand(appAtomRegistry, saveImage, { environmentId, input });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
