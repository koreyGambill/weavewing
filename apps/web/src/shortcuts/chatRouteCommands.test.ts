import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import * as commandPalette from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import * as previewActions from "../components/preview/previewActionBus";
import * as threadActions from "../lib/chatThreadActions";
import * as scratchProject from "../hooks/useScratchProject";
import * as session from "../state/session";
import { installChatRouteCommands } from "./chatRouteCommands";
import * as dispatcher from "./dispatcher";

describe("new thread commands", () => {
  it.each([
    { command: "chat.new", inProject: false, opens: "default place" },
    { command: "chat.newLocal", inProject: true, opens: "current project" },
    { command: "chat.newLocal", inProject: false, opens: "default place" },
  ] as const)(
    "$command, in a project=$inProject, opens the $opens",
    async ({ command, inProject, opens }) => {
      using openPicker = vi
        .spyOn(commandPalette, "openCommandPalette")
        .mockImplementation(() => {});
      using startLocal = vi
        .spyOn(threadActions, "startNewThreadFromContext")
        .mockResolvedValue(inProject);
      const startDefaultPlace = vi.fn().mockResolvedValue(true);
      using _scratch = vi
        .spyOn(scratchProject, "readScratchProjectActions")
        .mockReturnValue({ startDefaultPlace } as never);
      using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
      const router = { state: { matches: [] } } as unknown as AnyRouter;
      using stack = new DisposableStack();
      stack.defer(installChatRouteCommands(router));
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as KeyboardEvent;

      register.mock.calls.at(-1)![0][command]!(event);

      // Nothing to answer first, and only the default-place resolver picks a fallback.
      await vi.waitFor(() =>
        expect(startDefaultPlace).toHaveBeenCalledTimes(opens === "default place" ? 1 : 0),
      );
      expect(openPicker).not.toHaveBeenCalled();
      if (command === "chat.newLocal") {
        expect(startLocal.mock.calls[0]![0].defaultProjectRef).toBeNull();
      }
    },
  );
});

describe("new thread over Settings", () => {
  it("closes Settings for a new thread unless a field or another dialog has the key", () => {
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = {
      state: {
        matches: [
          { routeId: "/_chat", pathname: "/" },
          { routeId: "/_chat/settings", pathname: "/settings" },
        ],
      },
    } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const [modalCommands, modalOptions] = register.mock.calls[0]!;
    const [, routeOptions] = register.mock.calls[1]!;
    expect(Object.keys(modalCommands).toSorted()).toEqual(["chat.new", "chat.newLocal"]);
    let dialogOpen = false;
    const keyOn = (tagName: string) =>
      ({
        target: { tagName, ownerDocument: { querySelector: () => (dialogOpen ? {} : null) } },
      }) as unknown as KeyboardEvent;
    expect(routeOptions?.when?.(keyOn("BODY"))).toBe(false);
    expect(modalOptions?.when?.(keyOn("BODY"))).toBe(true);
    expect(modalOptions?.when?.(keyOn("INPUT"))).toBe(false);
    dialogOpen = true;
    expect(modalOptions?.when?.(keyOn("BODY"))).toBe(false);
  });
});

describe("preview commands", () => {
  it.each([
    { command: "preview.find", action: "find" },
    { command: "preview.refresh", action: "refresh" },
    { command: "preview.focusUrl", action: "focus-url" },
  ] as const)("$command reaches the right panel on a draft thread", ({ command, action }) => {
    const draftId = DraftId.make("draft-1");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("active") },
        draftId,
      );
    using stack = new DisposableStack();
    stack.defer(() => useComposerDraftStore.getState().clearDraftThread(draftId));
    using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
    using dispatch = vi.spyOn(previewActions, "dispatchPreviewAction").mockImplementation(() => {});
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = {
      state: { matches: [{ routeId: "/_chat/draft/$draftId", params: { draftId } }] },
    } as unknown as AnyRouter;
    stack.defer(installChatRouteCommands(router));
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;

    register.mock.calls.at(-1)![0][command]!(event);

    expect(dispatch).toHaveBeenCalledWith(action);
  });
});
