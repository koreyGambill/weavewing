import { describe, expect, it } from "vite-plus/test";
import {
  filterSidebarComputerThreads,
  groupSidebarComputers,
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

describe("filterSidebarComputerThreads", () => {
  const threads = [
    { environmentId: "a", id: "1" },
    { environmentId: "b", id: "2" },
    { environmentId: "b", id: "3" },
  ];

  it("keeps threads on chosen servers and the open thread", () => {
    expect(
      filterSidebarComputerThreads(threads, new Set(["a"]), "b:3").map((thread) => thread.id),
    ).toEqual(["1", "3"]);
  });

  it("keeps every thread without a choice", () => {
    expect(filterSidebarComputerThreads(threads, null, null)).toBe(threads);
  });
});

describe("toggleSidebarComputerScope", () => {
  it("adds and removes a server", () => {
    expect(toggleSidebarComputerScope(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleSidebarComputerScope(["a", "b"], "a")).toEqual(["b"]);
  });
});
