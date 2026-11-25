import type { DefaultContextItem, DefaultContextPreview } from "@t3tools/contracts";

const CATEGORY_LABELS: Record<DefaultContextItem["category"], string> = {
  t3: "T3 instructions",
  files: "Instruction files",
  skills: "Skill listing",
  tools: "T3 tools",
  "app-context": "App context",
  custom: "Custom append",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as ReadonlyArray<
  DefaultContextItem["category"]
>;

export const DELIVERY_LABELS: Record<DefaultContextItem["delivery"], string> = {
  "every-turn": "every turn",
  "first-prompt": "first prompt",
  "session-start": "session start",
  "on-demand": "on demand",
};

export const STATUS_LABELS: Record<NonNullable<DefaultContextItem["status"]>, string> = {
  expected: "Expected",
  loaded: "Loaded last turn",
  "not-loaded": "Expected, not loaded last turn",
  unexpected: "Loaded last turn, not expected",
  "not-read": "Outside the instruction folders, not read",
  secret: "Credential or state file, not read",
};

export const TOOL_PREVIEW_COUNT = 20;

export interface CategoryTotal {
  readonly category: DefaultContextItem["category"];
  readonly label: string;
  readonly bytes: number;
  readonly tokens: number;
  readonly share: number;
}

/** Totals count only what loads by default; deferred and unread items stay out. */
export function defaultContextSummary(preview: DefaultContextPreview) {
  const counted = preview.items.filter((item) => item.counted);
  const bytes = counted.reduce((sum, item) => sum + item.bytes, 0);
  const tokens = counted.reduce((sum, item) => sum + item.estimatedTokens, 0);
  const categories: CategoryTotal[] = CATEGORY_ORDER.flatMap((category) => {
    const items = counted.filter((item) => item.category === category);
    if (items.length === 0) return [];
    const categoryBytes = items.reduce((sum, item) => sum + item.bytes, 0);
    return [
      {
        category,
        label: CATEGORY_LABELS[category],
        bytes: categoryBytes,
        tokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0),
        share: bytes === 0 ? 0 : categoryBytes / bytes,
      },
    ];
  });
  const groups = CATEGORY_ORDER.flatMap((category) => {
    const items = preview.items.filter((item) => item.category === category);
    return items.length === 0 ? [] : [{ category, label: CATEGORY_LABELS[category], items }];
  });
  const attention = preview.items.filter(
    (item) => item.status === "not-loaded" || item.status === "unexpected",
  ).length;
  // The same categories a footprint records, compared as one total so relabelled parts never show as changes.
  const injectedBytes = preview.items
    .filter(
      (item) =>
        item.category !== "files" && item.category !== "skills" && item.category !== "tools",
    )
    .reduce((sum, item) => sum + item.bytes, 0);
  const injectedDiff =
    preview.lastTurn === null ? null : injectedBytes - preview.lastTurn.injectedBytes;
  return { bytes, tokens, categories, groups, attention, injectedDiff };
}

/** Nests files under the file whose markdown link lists them; a link whose parent is missing stays top-level. */
export function fileTree(items: ReadonlyArray<DefaultContextItem>) {
  const ids = new Set(items.map((item) => item.id));
  const childrenOf = new Map<string, DefaultContextItem[]>();
  const roots: DefaultContextItem[] = [];
  for (const item of items) {
    if (item.parentId === undefined || !ids.has(item.parentId)) roots.push(item);
    else childrenOf.set(item.parentId, [...(childrenOf.get(item.parentId) ?? []), item]);
  }
  return { roots, childrenOf };
}

/** Splits a path so a narrow row can truncate the folder and keep the file name whole. */
export function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

export function shortenPath(path: string, home: string | null) {
  return home !== null && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

/** The home directory, inferred from a path under `/home/<user>` or `/Users/<user>`. */
export function homeOf(paths: ReadonlyArray<string>) {
  for (const path of paths) {
    const match = /^(\/(?:home|Users)\/[^/]+)(?:\/|$)/.exec(path);
    if (match?.[1]) return match[1];
  }
  return null;
}

export const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
export const formatBytes = (bytes: number) =>
  bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

export interface UsedContextSource {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
  /** Counted items, largest first; empty for rows derived from the provider's report. */
  readonly items: ReadonlyArray<DefaultContextItem>;
}

const slashes = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const withinFolder = (path: string, folder: string) =>
  slashes(path) === slashes(folder) || slashes(path).startsWith(`${slashes(folder)}/`);

/**
 * Splits the context in use into what T3 can itemize and what it can only infer. The remainder is
 * the first reported prompt minus the itemized estimates; without that report it also holds the
 * conversation. Null when the provider's default context is unsupported.
 */
export function usedContextSources(preview: DefaultContextPreview, usedTokens: number) {
  if (preview.support === "unsupported") return null;
  const counted = preview.items.filter((item) => item.counted);
  const isFile = (item: DefaultContextItem) => item.category === "files";
  const inRepository = (item: DefaultContextItem) =>
    preview.cwd !== null && withinFolder(item.label, preview.cwd);
  const groups: Array<[key: string, label: string, test: (item: DefaultContextItem) => boolean]> = [
    ["t3", CATEGORY_LABELS.t3, (item) => item.category === "t3"],
    ["app-context", CATEGORY_LABELS["app-context"], (item) => item.category === "app-context"],
    ["custom", CATEGORY_LABELS.custom, (item) => item.category === "custom"],
    ["repository-files", "Repository instructions", (item) => isFile(item) && inRepository(item)],
    ["global-files", "Global instructions", (item) => isFile(item) && !inRepository(item)],
    ["skills", CATEGORY_LABELS.skills, (item) => item.category === "skills"],
    ["tools", CATEGORY_LABELS.tools, (item) => item.category === "tools"],
  ];
  const sources: UsedContextSource[] = groups.flatMap(([key, label, test]) => {
    const items = counted.filter(test).toSorted((a, b) => b.estimatedTokens - a.estimatedTokens);
    const tokens = items.reduce((sum, item) => sum + item.estimatedTokens, 0);
    return tokens === 0 ? [] : [{ key, label, tokens, items }];
  });
  const known = sources.reduce((sum, source) => sum + source.tokens, 0);
  const used = Math.max(0, usedTokens);
  const baseline = preview.firstTurn?.promptTokens ?? null;
  if (baseline === null) {
    sources.push({
      key: "rest",
      label: "Harness, built-in tools and conversation (not itemized)",
      tokens: Math.max(0, used - known),
      items: [],
    });
  } else {
    sources.push(
      {
        key: "harness",
        label: "Harness and built-in tools (not itemized)",
        tokens: Math.max(0, baseline - known),
        items: [],
      },
      {
        key: "conversation",
        label: "Conversation since the first turn",
        tokens: Math.max(0, used - baseline),
        items: [],
      },
    );
  }
  return {
    sources: sources.toSorted((a, b) => b.tokens - a.tokens),
    knownTokens: known,
    firstTurnTokens: baseline,
  };
}
