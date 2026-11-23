import { describe, expect, it } from "vite-plus/test";

import { resolveFileHeaderActions } from "./fileHeaderActions.logic";

const workspaceFile = {
  absolutePath: "/repo/src/index.ts",
  isFolder: false,
  isHostFile: false,
  openInSupported: true,
  searchableText: true,
  truncated: false,
};

const enabled = { disabledReason: null };
const disabledWith = expect.objectContaining({ disabledReason: expect.any(String) });

describe("resolveFileHeaderActions", () => {
  it("keeps the core actions for a read-only file outside the workspace", () => {
    const actions = resolveFileHeaderActions({
      ...workspaceFile,
      absolutePath: "/home/me/notes/plan.md",
      isHostFile: true,
    });
    expect(actions.openIn).toEqual(enabled);
    expect(actions.copyPath).toEqual(enabled);
    expect(actions.explorer).toEqual(disabledWith);
    expect(actions.find).toEqual(enabled);
  });

  it("disables Open in instead of hiding it when the environment cannot open editors", () => {
    const actions = resolveFileHeaderActions({ ...workspaceFile, openInSupported: false });
    expect(actions.openIn).toEqual(disabledWith);
    expect(actions.copyPath).toEqual(enabled);
  });

  it("keeps find visible but disabled for a truncated text file", () => {
    expect(resolveFileHeaderActions({ ...workspaceFile, truncated: true }).find).toEqual(
      disabledWith,
    );
  });

  it("offers no find for media or documents, but keeps the core actions", () => {
    const actions = resolveFileHeaderActions({ ...workspaceFile, searchableText: false });
    expect(actions.find).toBeNull();
    expect(actions.openIn).toEqual(enabled);
    expect(actions.copyPath).toEqual(enabled);
    expect(actions.explorer).toEqual(enabled);
  });

  it("drops the explorer toggle and find on folder views", () => {
    const actions = resolveFileHeaderActions({ ...workspaceFile, isFolder: true });
    expect(actions.explorer).toBeNull();
    expect(actions.find).toBeNull();
    expect(actions.copyPath).toEqual(enabled);
  });

  it("offers nothing without a host path", () => {
    expect(resolveFileHeaderActions({ ...workspaceFile, absolutePath: null })).toEqual({
      openIn: null,
      copyPath: null,
      explorer: null,
      find: null,
    });
  });
});
