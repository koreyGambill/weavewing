/**
 * Review comments from the file and diff tiles, shaped like the ones users attach.
 * Source: a user's file comment on line 20 reached the agent as `range: L20 (19-19)`
 * (thread "Thread Sidebar Density and Synced Groups", decision D9).
 */
export interface Case {
  readonly id: string;
  readonly filePath: string;
  readonly sectionTitle: string;
  /** Zero-based row offsets the client stores; for diffs they count diff rows, not file lines. */
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly comment: string;
  readonly snippet: string;
  readonly fenceLanguage: string;
  /** The file lines the agent should act on. */
  readonly expectedStart: number;
  readonly expectedEnd: number;
}

export const cases: ReadonlyArray<Case> = [
  {
    id: "file-single-line",
    filePath: "src/config.ts",
    sectionTitle: "File comment",
    startIndex: 19,
    endIndex: 19,
    rangeLabel: "L20",
    comment: "Raise this timeout to 30 seconds.",
    snippet: "export const requestTimeoutMs = 10_000;",
    fenceLanguage: "ts",
    expectedStart: 20,
    expectedEnd: 20,
  },
  {
    id: "file-range",
    filePath: "docs/setup.md",
    sectionTitle: "File comment",
    startIndex: 18,
    endIndex: 23,
    rangeLabel: "L19 to L24",
    comment: "This whole Windows section is obsolete. Delete these lines.",
    snippet: [
      "## Windows",
      "",
      "Install the legacy driver first:",
      "",
      "    choco install acme-driver",
      "",
    ].join("\n"),
    fenceLanguage: "md",
    expectedStart: 19,
    expectedEnd: 24,
  },
  {
    id: "diff-added-line",
    filePath: "src/retry.ts",
    sectionTitle: "Working tree",
    startIndex: 7,
    endIndex: 7,
    rangeLabel: "+42",
    comment: "Rename maxTries to retryLimit on this line.",
    snippet: "@@ -42,0 +42,1 @@\n+const maxTries = 5;",
    fenceLanguage: "diff",
    expectedStart: 42,
    expectedEnd: 42,
  },
];
