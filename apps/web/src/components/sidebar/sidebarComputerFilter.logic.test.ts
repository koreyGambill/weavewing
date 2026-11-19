import { describe, expect, it } from "vite-plus/test";
import {
  groupSidebarComputers,
  isSidebarComputerThreadShown,
  pruneSidebarComputerScope,
  resolveSidebarComputerScope,
  toggleSidebarComputerScope,
} from "./sidebarComputerFilter.logic";

const server = (environmentId: string, computer: string | null) => ({
  environmentId,
  label: environmentId,
  computer,
});

describe("groupSidebarComputers", () => {
  it("lists servers under their computer in first-seen order, and unknown computers last", () => {
    expect(
      groupSidebarComputers([
        server("laptop-wsl", "laptop"),
        server("cloud", null),
        server("desk", "desk-pc"),
        server("laptop-win", "laptop"),
      ]),
    ).toEqual([
      {
        computer: "laptop",
        servers: [server("laptop-wsl", "laptop"), server("laptop-win", "laptop")],
      },
      { computer: "desk-pc", servers: [server("desk", "desk-pc")] },
      { computer: null, servers: [server("cloud", null)] },
    ]);
  });
});

describe("resolveSidebarComputerScope", () => {
  it("is every computer when nothing is chosen", () => {
    expect(resolveSidebarComputerScope({ storedIds: [], knownIds: ["a"], ready: true })).toBe(null);
  });

  it("keeps chosen servers that still exist", () => {
    expect(
      resolveSidebarComputerScope({ storedIds: ["a", "gone"], knownIds: ["a", "b"], ready: true }),
    ).toEqual(new Set(["a"]));
  });

  it("reads as every computer once all chosen servers are removed", () => {
    expect(resolveSidebarComputerScope({ storedIds: ["gone"], knownIds: ["a"], ready: true })).toBe(
      null,
    );
  });

  it("keeps a chosen server that has not loaded yet", () => {
    expect(
      resolveSidebarComputerScope({ storedIds: ["later"], knownIds: [], ready: false }),
    ).toEqual(new Set(["later"]));
  });
});

describe("isSidebarComputerThreadShown", () => {
  const onB = { environmentId: "b", id: "2" };

  it("shows threads on chosen servers and the open thread", () => {
    expect(
      isSidebarComputerThreadShown({ environmentId: "a", id: "1" }, new Set(["a"]), null),
    ).toBe(true);
    expect(isSidebarComputerThreadShown(onB, new Set(["a"]), null)).toBe(false);
    expect(isSidebarComputerThreadShown(onB, new Set(["a"]), "b:2")).toBe(true);
  });

  it("shows every thread without a choice", () => {
    expect(isSidebarComputerThreadShown(onB, null, null)).toBe(true);
  });
});

describe("toggleSidebarComputerScope", () => {
  it("adds and removes a server", () => {
    expect(toggleSidebarComputerScope(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleSidebarComputerScope(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("pruneSidebarComputerScope", () => {
  it("drops a server that is no longer in the loaded catalog", () => {
    expect(
      pruneSidebarComputerScope({ storedIds: ["a", "removed"], knownIds: ["a"], ready: true }),
    ).toEqual(["a"]);
  });

  it("keeps a saved server that is offline, since the catalog still lists it", () => {
    expect(
      pruneSidebarComputerScope({
        storedIds: ["offline"],
        knownIds: ["offline", "a"],
        ready: true,
      }),
    ).toBe(null);
  });

  it("changes nothing before the catalog has loaded", () => {
    expect(pruneSidebarComputerScope({ storedIds: ["later"], knownIds: [], ready: false })).toBe(
      null,
    );
  });
});
