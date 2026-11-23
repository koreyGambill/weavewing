import type {
  RepositoryIdentity,
  SourceControlFileLink,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createFileLinkLookup,
  fileLinkRanges,
  fileLinkPreflight,
  resolveFileRangeActions,
  resolveFileRemoteActions,
  settleFileLink,
} from "./fileRemoteActions.ts";

const target = (ref: string) => ({ ref, url: `https://github.com/a/b/blob/${ref}/x.ts` });
const available = (
  link: Partial<Extract<SourceControlFileLink, { _tag: "Available" }>>,
): SourceControlFileLink => ({
  _tag: "Available",
  provider: "github" as SourceControlProviderKind,
  providerLabel: "GitHub",
  remoteName: "origin",
  choice: "default",
  branch: "feature",
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

  it("tells a branch without an upstream apart from a detached HEAD", () => {
    const noUpstream = byId(
      resolveFileRemoteActions({
        status: "ready",
        link: available({ choice: "default-without-upstream", currentBranch: null }),
      }),
    );
    expect(noUpstream["open-on-forge"]?.detail).toContain("feature has no upstream on origin");
    expect(noUpstream["open-current-branch"]).toMatchObject({
      url: null,
      disabledReason: "feature has no upstream on origin",
    });
    const detached = byId(
      resolveFileRemoteActions({
        status: "ready",
        link: available({ choice: "default-without-upstream", currentBranch: null, branch: null }),
      }),
    );
    expect(detached["open-on-forge"]?.detail).toContain("HEAD is detached");
    expect(detached["open-current-branch"]?.disabledReason).toBe(
      "HEAD is detached, so there is no current branch",
    );
  });

  it("says why it linked the current branch", () => {
    const current = byId(
      resolveFileRemoteActions({
        status: "ready",
        link: available({ choice: "current", link: target("feature") }),
      }),
    );
    expect(current["open-on-forge"]?.detail).toContain("the current branch");
  });

  it("disables every forge action with the reason, for each way a link can be missing", () => {
    const reasons = [
      [
        { _tag: "Unavailable", reason: "unsupported-host", host: "code.example.test" },
        "T3 Code cannot link files on code.example.test",
      ],
      [
        { _tag: "Unavailable", reason: "network-path" },
        "T3 Code does not read git on network paths",
      ],
      [{ _tag: "Unavailable", reason: "outside-workspace" }, "This path leaves its workspace"],
    ] as const;
    for (const [link, reason] of reasons) {
      const actions = resolveFileRemoteActions({ status: "ready", link });
      expect(actions[0]).toMatchObject({ label: "Open on remote", disabledReason: reason });
      expect(actions.every((action) => action.disabledReason !== null)).toBe(true);
    }
    expect(resolveFileRemoteActions({ status: "timed-out" })[0]?.disabledReason).toBe(
      "Couldn't read git in time",
    );
  });
});

describe("resolveFileRangeActions", () => {
  it("labels the open and copy pair with its range", () => {
    expect(
      resolveFileRangeActions({ status: "ready", link: available({}) }, "72-80").map(
        ({ id, label, url }) => ({ id, label, url }),
      ),
    ).toEqual([
      { id: "open-lines:72-80", label: "Open lines 72-80 on GitHub", url: target("main").url },
      { id: "copy-lines:72-80", label: "Copy GitHub link to lines 72-80", url: target("main").url },
    ]);
  });
});

describe("settleFileLink", () => {
  it("reports a lookup that outlasts the timeout as timed out", async () => {
    vi.useFakeTimers();
    try {
      const settled = settleFileLink(new Promise<SourceControlFileLink>(() => {}), 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(settled).resolves.toEqual({ status: "timed-out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed lookup as failed and a finished one as ready", async () => {
    await expect(settleFileLink(Promise.reject(new Error("boom")))).resolves.toEqual({
      status: "failed",
    });
    const link = available({});
    await expect(settleFileLink(Promise.resolve(link))).resolves.toEqual({
      status: "ready",
      link,
    });
  });
});

describe("createFileLinkLookup", () => {
  it("runs one lookup, and shows its result only once it is in", async () => {
    const link = available({});
    const load = vi.fn(() => Promise.resolve(link));
    const lookup = createFileLinkLookup(load);
    expect(lookup.settled()).toBeNull();
    const first = lookup.start();
    const second = lookup.start();
    await expect(first).resolves.toEqual({ status: "ready", link });
    await second;
    expect(load).toHaveBeenCalledTimes(1);
    expect(lookup.settled()).toEqual({ status: "ready", link });
  });
});

describe("fileLinkPreflight", () => {
  const identity = (canonicalKey: string, provider?: string): RepositoryIdentity => ({
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
    ...(provider ? { provider: provider as SourceControlProviderKind } : {}),
  });

  it("enables a forge that links files and names it", () => {
    expect(
      fileLinkPreflight({ canReadFiles: true, identity: identity("github.com/a/b", "github") }),
    ).toEqual({ forge: "GitHub", disabledReason: null });
  });

  it("gives the reason when no link can exist", () => {
    expect(
      fileLinkPreflight({ canReadFiles: false, identity: identity("github.com/a/b", "github") })
        .disabledReason,
    ).toBe("This connection cannot read files");
    expect(fileLinkPreflight({ canReadFiles: true, identity: null }).disabledReason).toBe(
      "This project is not a git repository with a remote",
    );
    expect(
      fileLinkPreflight({ canReadFiles: true, identity: identity("code.example.test/a/b") })
        .disabledReason,
    ).toBe("T3 Code cannot link files on code.example.test");
  });
});

describe("fileLinkRanges", () => {
  it("puts a single cited range into the main links", () => {
    expect(fileLinkRanges([{ line: 72, endLine: 80 }])).toEqual({
      main: { line: 72, endLine: 80 },
      each: [],
    });
  });

  it("gives several ranges a pair each and leaves the main links whole", () => {
    const ranges = [{ line: 3 }, { line: 72, endLine: 80 }];
    expect(fileLinkRanges(ranges)).toEqual({ main: undefined, each: ranges });
    expect(fileLinkRanges([])).toEqual({ main: undefined, each: [] });
  });
});
