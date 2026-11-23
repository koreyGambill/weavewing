import * as Schema from "effect/Schema";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";
import remarkParse from "remark-parse";
import { unified } from "unified";

export const FileLinksExpect = Schema.Struct({
  /** The final answer has at least this many file pills that open a world file. */
  minWorking: Schema.Number,
  /** Every pill is an absolute path, which opens wherever the thread's folder is. */
  absolute: Schema.optional(Schema.Boolean),
  /** Files, relative to the thread cwd, that some pill must open, at a range covering `line`. */
  cites: Schema.optional(
    Schema.Array(Schema.Struct({ file: Schema.String, line: Schema.optional(Schema.Number) })),
  ),
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

const chatMarkdown = unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS);

type MarkdownNode = {
  readonly type: string;
  readonly url?: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<MarkdownNode>;
};

/**
 * Each pill's authored destination, read as chat reads the answer: links (bare absolute paths
 * included) and inline code outside links, decoded the way the renderer decodes them.
 */
const pillSources = (finalText: string) => {
  const sources: Array<string> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "link" && node.url !== undefined) {
      sources.push(node.url);
      // Code in a link's label renders inside that link's pill.
      return;
    }
    if (node.type === "inlineCode" && node.value !== undefined) {
      const candidate = inlineCodeFilePathCandidate(node.value);
      if (candidate !== null) sources.push(candidate);
    }
    node.children?.forEach(visit);
  };
  visit(chatMarkdown.runSync(chatMarkdown.parse(finalText)) as MarkdownNode);
  return sources;
};

/**
 * Chat turns every file-shaped markdown link and inline code span into a pill resolved against
 * the thread's cwd. A pill works only when that literal path is a world file or directory: the
 * client opens nothing else in its place.
 * `absolute` is whether its decoded destination names a path from the filesystem root.
 */
export const fileLinkPills = (
  finalText: string,
  cwd: string,
  worldFiles: ReadonlyArray<string>,
) => {
  const files = worldFiles.map((file) => (file.startsWith("/") ? file : `${cwd}/${file}`));
  return [...new Set(pillSources(finalText))].flatMap((source) => {
    const target = resolveMarkdownFileLinkTarget(source, cwd);
    const authored = parseMarkdownFileLink(source);
    if (target === null || authored === null) return [];
    // A quoted module specifier such as `./ws` names no file the user would open, so agents keep it.
    if (/^\.{1,2}\/(?:[^/]+\/)*[^/.]+$/.test(authored.path)) return [];
    const position = splitFilePathPosition(target);
    const path = normalizeAbsolutePath(position.path);
    // System paths such as /usr/bin/node are not what these cases test; the workspace always is.
    if (!path.startsWith(`${cwd}/`) && !/^\/(?:home|Users)\//.test(path)) return [];
    const absolute = !isRelativeFilePath(authored.path);
    const works = files.some((file) => file === path || file.startsWith(`${path}/`));
    const { line, endLine } = authored;
    return [{ source, path, line, endLine, absolute, works }];
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
  const relative = pills.filter((pill) => !pill.absolute).map((pill) => pill.source);
  return [
    ...(expect.absolute
      ? [
          {
            check: `fileLinks absolute ${pills.length - relative.length}/${pills.length}${relative.length ? `: ${relative.join(", ")}` : ""}`,
            pass: finalText !== undefined && cwd !== undefined && relative.length === 0,
          },
        ]
      : []),
    ...(expect.cites ?? []).map(({ file, line }) => ({
      check: `fileLinks cites ${file}${line === undefined ? "" : `:${line}`}`,
      pass: pills.some(
        (pill) =>
          pill.path === `${cwd}/${file}` &&
          (line === undefined ||
            (pill.line !== undefined && pill.line <= line && line <= (pill.endLine ?? pill.line))),
      ),
    })),
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
