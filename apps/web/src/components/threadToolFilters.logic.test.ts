import { describe, expect, it } from "vite-plus/test";
import {
  linksCopyText,
  markTimestamp,
  matchesToolFilter,
  visibleMarks,
} from "./threadToolFilters.logic";

const mark = (url: string, service: string, timestamp: string, description = "") => ({
  url,
  service,
  timestamp,
  description,
  name: undefined,
});

describe("thread tool filters", () => {
  it("matches every word in any field, ignoring case", () => {
    expect(matchesToolFilter(["BW-42", "Render tickets"], "bw-42 RENDER")).toBe(true);
    expect(matchesToolFilter(["BW-42", null, undefined], "")).toBe(true);
    expect(matchesToolFilter(["BW-42"], "bw-42 slack")).toBe(false);
  });

  it("formats mark times in local or UTC, 12 or 24 hours", () => {
    expect(markTimestamp("2026-11-06T16:05:00Z", true, false)).toBe("2026-11-06 04:05 PM");
    expect(markTimestamp("2026-11-06T16:05:00Z", true, true)).toBe("2026-11-06 16:05");
    expect(markTimestamp("not a date", true, true)).toBe("");
  });

  const marks = [
    mark("https://notion.so/spec", "Notion", "2026-11-06T04:15:00Z", "Design spec"),
    mark("https://github.com/org/repo/pull/7", "GitHub", "2026-11-07T04:15:00Z"),
    mark("https://team.slack.com/archives/1", "Slack", "2026-11-05T04:15:00Z"),
  ];

  it("filters by service and by text across url, description and both times", () => {
    const base = { filter: "", service: "all", sort: "newest", hour24: true } as const;
    expect(
      visibleMarks(marks, { ...base, service: "Slack" }).map((entry) => entry.service),
    ).toEqual(["Slack"]);
    expect(
      visibleMarks(marks, { ...base, filter: "design" }).map((entry) => entry.service),
    ).toEqual(["Notion"]);
    expect(
      visibleMarks(marks, { ...base, filter: "2026-11-07 04:15" }).map((entry) => entry.service),
    ).toEqual(["GitHub"]);
  });

  it("sorts newest, oldest, by service and by link", () => {
    const sorted = (sort: "newest" | "oldest" | "service" | "link") =>
      visibleMarks(marks, { filter: "", service: "all", sort, hour24: true }).map(
        (entry) => entry.service,
      );
    expect(sorted("newest")).toEqual(["GitHub", "Notion", "Slack"]);
    expect(sorted("oldest")).toEqual(["Slack", "Notion", "GitHub"]);
    expect(sorted("service")).toEqual(["GitHub", "Notion", "Slack"]);
    expect(sorted("link")).toEqual(["GitHub", "Notion", "Slack"]);
  });

  it("copies one line per shown ticket, pull request and link, skipping missing parts", () => {
    expect(
      linksCopyText({
        tickets: [
          { ticket: "BW-1", label: "Open", url: "https://bitwing.dev/BW-1" },
          { ticket: "BW-2" },
        ],
        pullRequests: [{ url: "https://github.com/org/repo/pull/7", title: "Fix it" }],
        marks: ["2026-11-07 04:15 GitHub https://github.com/org/repo/issues/3"],
      }),
    ).toBe(
      [
        "BW-1 Open https://bitwing.dev/BW-1",
        "BW-2",
        "https://github.com/org/repo/pull/7 Fix it",
        "2026-11-07 04:15 GitHub https://github.com/org/repo/issues/3",
      ].join("\n"),
    );
    expect(linksCopyText({ tickets: [], pullRequests: [], marks: [] })).toBe("");
  });
});
