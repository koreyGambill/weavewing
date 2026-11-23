import { isLocalEditorFileUrl } from "@t3tools/contracts";
import { renderCodexInlineDirectivesAsMarkdown } from "@t3tools/shared/codexMarkdownDirectives";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import {
  chatMarkdownLinkSources,
  decodeMarkdownLinkEscapes,
} from "@t3tools/shared/markdownPipeline";
import { defaultUrlTransform } from "react-markdown";
import { fileBasename, isAbsolutePath, workspaceRelativeFilePath } from "@t3tools/shared/path";
import {
  extractInlineCodeSpans,
  extractMarkdownLinkHrefs,
  inlineCodeFilePathCandidate,
  isWindowsDrivePathHref,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  workspaceLookupPath: string | null;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
  endLine?: number;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const rewrittenHref = rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
  return WINDOWS_DRIVE_PATH_REGEX.test(rewrittenHref)
    ? rewrittenHref.replaceAll("\\", "/")
    : rewrittenHref;
}

interface MarkdownFileLinkSource {
  readonly source: string;
  readonly meta: MarkdownFileLinkMeta;
}

/**
 * Candidate file links in a message, keyed as the renderer looks them up. A fast scan, so it can
 * include links the renderer never shows, such as ones inside code blocks.
 */
export function markdownFileLinkSources(
  text: string,
  cwd: string | undefined,
  baseDir: string | undefined = cwd,
): { hrefs: MarkdownFileLinkSource[]; spans: MarkdownFileLinkSource[] } {
  const hrefs = extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(text)).flatMap(
    (href) => {
      if (parseComposerContextHref(href)) return [];
      const source = normalizeMarkdownLinkHrefKey(decodeMarkdownLinkEscapes(href));
      const meta = resolveMarkdownFileLinkMeta(source, cwd, baseDir);
      return meta ? [{ source, meta }] : [];
    },
  );
  const spans = extractInlineCodeSpans(text).flatMap((source) => {
    const meta = resolveInlineCodeFileLinkMeta(source, cwd, baseDir);
    return meta ? [{ source, meta }] : [];
  });
  return { hrefs, spans };
}

// Mirrors ChatMarkdown's url transform, which empties hrefs it will not render as links.
function renderedMarkdownHref(href: string): string | null {
  if (isWindowsDrivePathHref(href) || isLocalEditorFileHref(href)) return href;
  return rewriteMarkdownFileUriHref(href) ?? (defaultUrlTransform(href) || null);
}

/** The file links a message renders, read from the chat renderer's own markdown parse. */
export function renderedMarkdownFileLinks(
  text: string,
  cwd: string | undefined,
  options: { readonly userMessage?: boolean } = {},
): MarkdownFileLinkMeta[] {
  const { hrefs, inlineCode } = chatMarkdownLinkSources(text, options);
  return [
    ...hrefs.flatMap((href) => {
      if (parseComposerContextHref(href)) return [];
      const rendered = renderedMarkdownHref(href);
      const meta =
        rendered && resolveMarkdownFileLinkMeta(normalizeMarkdownLinkHrefKey(rendered), cwd);
      return meta ? [meta] : [];
    }),
    ...inlineCode.flatMap((span) => {
      const meta = resolveInlineCodeFileLinkMeta(span, cwd);
      return meta ? [meta] : [];
    }),
  ];
}

export function isLocalEditorFileHref(href: string): boolean {
  try {
    return isLocalEditorFileUrl(new URL(href));
  } catch {
    return false;
  }
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(
    candidate,
    cwd,
    inlineCodePathNamesFromWorkspaceRoot(candidate, cwd, baseDir) ? cwd : baseDir,
  );
}

function inlineCodePathNamesFromWorkspaceRoot(
  candidate: string,
  cwd: string | undefined,
  baseDir: string | undefined,
): boolean {
  if (!cwd || !baseDir || !isRelativeFilePath(candidate)) return false;
  if (/^(?:~|\.{1,2})\//.test(candidate)) return false;
  if (!splitFilePathPosition(candidate).path.includes("/")) return false;
  return workspaceRelativeFilePath(baseDir, cwd) !== null;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  const source = href ? parseMarkdownFileLink(href) : null;
  return {
    ...buildFileLinkMetaFromTarget(targetPath, cwd),
    ...(source?.endLine !== undefined ? { endLine: source.endLine } : {}),
    workspaceLookupPath:
      source !== null &&
      !isAbsolutePath(source.path) &&
      baseDir !== undefined &&
      workspaceRelativeFilePath(baseDir, cwd) === "."
        ? source.path
        : null,
  };
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string) {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
