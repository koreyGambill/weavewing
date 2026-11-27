import { ActivityIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveHostedViewLayout,
  resolveViewPage,
  viewHosts,
  viewPagePaletteDefinitions,
} from "./viewPage.logic";
import type { ViewDefinition } from "./viewRegistry";

function view(overrides: Partial<ViewDefinition> & Pick<ViewDefinition, "id">): ViewDefinition {
  return {
    title: overrides.id,
    icon: ActivityIcon,
    about: "",
    scope: "global",
    minWidthPx: 280,
    render: () => null,
    ...overrides,
  };
}

const calendar = view({ id: "calendar", page: "/view/$viewId" });
const pullRequests = view({
  id: "pull-requests",
  page: "/pull-requests",
  minWidthPx: 720,
  hosts: [],
});
const links = view({ id: "links", scope: "thread" });
// A wide global view without a page, such as a board before it gets one.
const board = view({ id: "status", minWidthPx: 720 });
const definitions = [calendar, pullRequests, links, board];

describe("view pages", () => {
  it("shows a global view with a page and refuses unknown, thread and pageless views", () => {
    expect(resolveViewPage("calendar", definitions)).toEqual({
      kind: "page",
      definition: calendar,
    });
    expect(resolveViewPage("pull-requests", definitions)).toEqual({
      kind: "own-route",
      definition: pullRequests,
    });
    expect(resolveViewPage("links", definitions)).toEqual({
      kind: "thread-view",
      definition: links,
    });
    expect(resolveViewPage("status", definitions)).toEqual({ kind: "unknown" });
    expect(resolveViewPage("nope", definitions)).toEqual({ kind: "unknown" });
  });

  it("renders a view compact below its minimum width, offering its page when it has one", () => {
    const wide = view({ id: "calendar", minWidthPx: 720, page: "/view/$viewId" });
    expect(resolveHostedViewLayout(wide, { layout: "full", width: 300 })).toEqual({
      layout: "compact",
      openFullSize: true,
    });
    expect(resolveHostedViewLayout(wide, { layout: "full", width: 720 })).toEqual({
      layout: "full",
      openFullSize: false,
    });
    expect(resolveHostedViewLayout(wide, { layout: "compact", width: 900 })).toEqual({
      layout: "compact",
      openFullSize: false,
    });
    expect(resolveHostedViewLayout(board, { layout: "full", width: 300 })).toEqual({
      layout: "compact",
      openFullSize: false,
    });
  });

  it("hosts a view in the panel and tiles by default, and a page-only view nowhere", () => {
    expect(viewHosts(calendar)).toEqual(["panel", "tile", "page"]);
    expect(viewHosts(links)).toEqual(["panel", "tile"]);
    expect(viewHosts(pullRequests)).toEqual([]);
  });

  it("offers palette pages only for views on the shared page", () => {
    expect(viewPagePaletteDefinitions(definitions)).toEqual([calendar]);
  });
});
