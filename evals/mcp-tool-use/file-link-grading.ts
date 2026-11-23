import * as Schema from "effect/Schema";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";

export const FileLinksExpect = Schema.Struct({
  /** The final answer has at least this many file pills that open a world file. */
  minWorking: Schema.Number,
});

/** Resolves `.` and `..` segments, which the file system resolves when the client opens the path. */
const normalizeAbsolutePath = (path: string) => {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  return `/${segments.join("/")}`;
};

/**
 * Chat turns every file-shaped markdown link and inline code span into a pill resolved against
 * the thread's cwd. A pill works only when that literal path is a world file or directory: the
 * client opens nothing else in its place.
 */
export const fileLinkPills = (
  finalText: string,
  cwd: string,
  worldFiles: ReadonlyArray<string>,
) => {
  const files = worldFiles.map((file) => (file.startsWith("/") ? file : `${cwd}/${file}`));
  // A link whose label names its own file renders as one pill, so code in that label is no pill.
  // Fenced blocks render as code, never as pills.
  const prose = finalText.replace(/```[\s\S]*?(?:```|$)/g, "");
  const withoutFileLabels = prose.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)\)/g,
    (link, label: string, href: string) =>
      isMarkdownFileLinkLabel(label.replaceAll("`", ""), normalizeMarkdownLinkDestination(href))
        ? `[](${href})`
        : link,
  );
  const sources = [
    // A link written inside inline code renders as code.
    ...extractMarkdownLinkHrefs(prose.replace(/`[^`\n]+`/g, "")),
    ...extractInlineCodeSpans(withoutFileLabels).flatMap(
      (span) => inlineCodeFilePathCandidate(span) ?? [],
    ),
  ];
  return [...new Set(sources)].flatMap((source) => {
    const target = resolveMarkdownFileLinkTarget(source, cwd);
    if (target === null) return [];
    const path = normalizeAbsolutePath(splitFilePathPosition(target).path);
    // System paths such as /usr/bin/node are not what these cases test; the workspace always is.
    if (!path.startsWith(`${cwd}/`) && !/^\/(?:home|Users)\//.test(path)) return [];
    const works = files.some((file) => file === path || file.startsWith(`${path}/`));
    return [{ source, path, works }];
  });
};

export const gradeFileLinks = (
  expect: typeof FileLinksExpect.Type | undefined,
  finalText: string | undefined,
  cwd: string | undefined,
  worldFiles: ReadonlyArray<string>,
) => {
  if (expect === undefined) return [];
  const pills = cwd === undefined ? [] : fileLinkPills(finalText ?? "", cwd, worldFiles);
  const broken = pills.filter((pill) => !pill.works).map((pill) => pill.source);
  const working = pills.length - broken.length;
  return [
    {
      check: `fileLinks none broken${broken.length ? `: ${broken.join(", ")}` : ""}`,
      pass: finalText !== undefined && cwd !== undefined && broken.length === 0,
    },
    {
      check: `fileLinks >= ${expect.minWorking} working (${working})`,
      pass: working >= expect.minWorking,
    },
  ];
};
