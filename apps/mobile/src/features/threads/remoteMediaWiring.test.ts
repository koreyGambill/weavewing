import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

// Upstream merges add Markdown surfaces; each must route remote media through the consent gate.
const sourceRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "native" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(sourceRoot).map((path) => ({
  name: NodePath.relative(sourceRoot, path),
  source: NodeFS.readFileSync(path, "utf8"),
}));

function missing(applies: RegExp, required: ReadonlyArray<RegExp>, exempt: readonly string[] = []) {
  const matched = files.filter(
    ({ name, source }) => applies.test(source) && !exempt.includes(name),
  );
  expect(matched.length).toBeGreaterThan(0);
  return matched
    .filter(({ source }) => required.some((pattern) => !pattern.test(source)))
    .map(({ name }) => name);
}

it("holds native Markdown images on every Markdown surface until consent", () => {
  expect(
    missing(/<SelectableMarkdownText\b/, [
      /useRemoteMediaImageSource\(/,
      /loadPendingRemoteMedia[(}]/,
    ]),
  ).toEqual([]);
});

it("gates every directly rendered Markdown image and video", () => {
  expect(
    missing(
      /<ThreadMarkdownImageView\b|<ThreadMarkdownVideo\b/,
      [/<(PullRequest)?RemoteMediaGate\b/],
      ["features/threads/ThreadMarkdownImage.tsx"],
    ),
  ).toEqual([]);
});

it("filters held remote images out of every Markdown preview gallery", () => {
  expect(
    missing(
      /const \w+: FilePreviewItem\[\] =[\s\S]*(markdownImageSources|pullRequestImageSource)\(/,
      [/allowedRemoteMediaItems\(/],
    ),
  ).toEqual([]);
});
