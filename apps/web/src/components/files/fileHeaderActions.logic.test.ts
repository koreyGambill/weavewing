import { describe, expect, it } from "vite-plus/test";

import type { SourceControlFileLink, SourceControlProviderKind } from "@t3tools/contracts";

import { resolveFileHeaderActions, resolveFileRemoteActions } from "./fileHeaderActions.logic";

const workspaceFile = {
  absolutePath: "/repo/src/index.ts",
  isFolder: false,
  isHostFile: false,
  openInSupported: true,
  searchableText: true,
  truncated: false,
  fileLink: null,
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
      remote: [],
    });
  });

  it("drops the explorer toggle for a pinned file such as Notes, keeping the rest", () => {
    const actions = resolveFileHeaderActions({
      ...workspaceFile,
      absolutePath: "/home/me/notes/thread.md",
      isHostFile: true,
      pinned: true,
      searchableText: false,
      fileLink: { status: "ready", link: { _tag: "Unavailable", reason: "not-repository" } },
    });
    expect(actions.explorer).toBeNull();
    expect(actions.find).toBeNull();
    expect(actions.openIn).toEqual(enabled);
    expect(actions.copyPath).toEqual(enabled);
    expect(actions.remote.map((action) => [action.id, action.placement])).toEqual([
      ["open-on-forge", "header"],
      ["copy-forge-link", "overflow"],
      ["open-default-branch", "overflow"],
      ["open-current-branch", "overflow"],
    ]);
  });

  it("offers no forge actions for a folder", () => {
    const actions = resolveFileHeaderActions({
      ...workspaceFile,
      isFolder: true,
      fileLink: { status: "loading" },
    });
    expect(actions.remote).toEqual([]);
  });
});

const target = (ref: string) => ({ ref, url: `https://github.com/a/b/blob/${ref}/x.ts` });
const available = (
  link: Partial<Extract<SourceControlFileLink, { _tag: "Available" }>>,
): SourceControlFileLink => ({
  _tag: "Available",
  provider: "github" as SourceControlProviderKind,
  providerLabel: "GitHub",
  remoteName: "origin",
  choice: "default",
  link: target("main"),
  defaultBranch: target("main"),
  currentBranch: target("feature"),
  ...link,
});
const byId = (actions: ReturnType<typeof resolveFileRemoteActions>) =>
  Object.fromEntries(actions.map((action) => [action.id, action]));

describe("resolveFileRemoteActions", () => {
  it("names the forge and the chosen ref", () => {
    const actions = byId(resolveFileRemoteActions({ status: "ready", link: available({}) }));
    expect(actions["open-on-forge"]).toMatchObject({
      label: "Open on GitHub",
      url: "https://github.com/a/b/blob/main/x.ts",
      detail: "main, the default branch",
      disabledReason: null,
    });
    expect(actions["copy-forge-link"]).toMatchObject({ label: "Copy GitHub link", kind: "copy" });
  });

  it("says why it linked the current branch or fell back to the default", () => {
    const current = byId(
      resolveFileRemoteActions({
        status: "ready",
        link: available({ choice: "current", link: target("feature") }),
      }),
    );
    expect(current["open-on-forge"]?.detail).toContain("the current branch");
    const fallback = byId(
      resolveFileRemoteActions({
        status: "ready",
        link: available({ choice: "default-without-upstream", currentBranch: null }),
      }),
    );
    expect(fallback["open-on-forge"]?.detail).toContain("no upstream on origin");
    expect(fallback["open-current-branch"]).toMatchObject({
      url: null,
      disabledReason: "This branch has no upstream on origin",
    });
  });

  it("disables every forge action, with a reason, when the file has no forge page", () => {
    const actions = resolveFileRemoteActions({
      status: "ready",
      link: { _tag: "Unavailable", reason: "unsupported-host", host: "code.example.test" },
    });
    expect(actions[0]).toMatchObject({
      label: "Open on remote",
      disabledReason: "T3 Code cannot link files on code.example.test",
    });
    expect(actions.every((action) => action.disabledReason !== null)).toBe(true);
  });
});
