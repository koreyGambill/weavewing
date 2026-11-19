import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import * as commandPalette from "../commandPaletteBus";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import * as previewActions from "../components/preview/previewActionBus";
import * as settings from "../hooks/useSettings";
import * as storage from "../hooks/useLocalStorage";
import * as threadActions from "../lib/chatThreadActions";
import * as entities from "../state/entities";
import * as presentation from "../state/presentation";
import * as atomRegistry from "../rpc/atomRegistry";
import * as scratchProject from "../hooks/useScratchProject";
import * as projectsState from "../state/projects";
import * as session from "../state/session";
import { Atom } from "effect/reactivity";
import type { Project } from "../types";
import { installChatRouteCommands } from "./chatRouteCommands";
import * as dispatcher from "./dispatcher";

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

const realGet = atomRegistry.appAtomRegistry.get.bind(atomRegistry.appAtomRegistry);

describe("new thread commands", () => {
  it.each([
    { mode: "normal", count: 2, command: "chat.new", place: "default" },
    { mode: "boring", count: 1, command: "chat.new", place: "default" },
    { mode: "boring", count: 2, command: "chat.newLocal", place: "project" },
  ] as const)("$mode sidebar, $count projects, $command opens the $place", (scenario) => {
    using _settings = vi.spyOn(settings, "getClientSettings").mockReturnValue({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    using _projects = vi
      .spyOn(entities, "readProjects")
      .mockReturnValue([project("active"), project("idle")].slice(0, scenario.count));
    using _connected = vi
      .spyOn(atomRegistry.appAtomRegistry, "get")
      .mockImplementation(((atom: unknown) =>
        atom === presentation.environmentSummaries.connectedEnvironmentIdsAtom
          ? [EnvironmentId.make("local")]
          : realGet(atom as never)) as typeof atomRegistry.appAtomRegistry.get);
    using _ready = vi
      .spyOn(projectsState, "defaultProjectFallbackReadyAtom")
      .mockReturnValue(Atom.make(true));
    using storedProject = vi.spyOn(storage, "getLocalStorageItem").mockReturnValue("local:active");
    using openPicker = vi.spyOn(commandPalette, "openCommandPalette").mockImplementation(() => {});
    using startLocal = vi.spyOn(threadActions, "startNewThreadFromContext").mockResolvedValue(true);
    const startDefaultPlace = vi.fn();
    const actual = scratchProject.createScratchProjectActions;
    using _scratch = vi
      .spyOn(scratchProject, "createScratchProjectActions")
      .mockImplementation((input) => ({ ...actual(input), startDefaultPlace }));
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = { state: { matches: [] } } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const commands = register.mock.calls.at(-1)![0];
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    storedProject.mockReturnValue("local:idle");
    commands[scenario.command]!(event);

    // Nothing to answer first: neither command stops at the palette's picker.
    expect(openPicker).not.toHaveBeenCalled();
    if (scenario.place === "default") {
      expect(startDefaultPlace).toHaveBeenCalledOnce();
      expect(startLocal).not.toHaveBeenCalled();
    } else {
      expect(startDefaultPlace).not.toHaveBeenCalled();
      expect(startLocal).toHaveBeenCalledOnce();
      expect(startLocal.mock.calls[0]![0].defaultProjectRef).toEqual({
        environmentId: "local",
        projectId: "idle",
      });
    }
  });
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
