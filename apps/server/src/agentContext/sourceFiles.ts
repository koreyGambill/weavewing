// @effect-diagnostics nodeBuiltinImport:off - lstat's link count and hashing need node builtins.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { AgentContextError, type AgentContextGeneratedRange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isCredentialPath } from "../threadInsights/InstructionFileAllowlist.ts";
import { MAX_READ_BYTES, readBounded } from "../threadInsights/instructionFiles.ts";
import { replaceHostFile } from "../workspace/replaceHostFile.ts";

const OPEN_MARKER = /^\s*<!--\s*overwing standards\b.*-->\s*$/;
const CLOSE_MARKER = /^\s*<!--\s*\/overwing standards\s*-->\s*$/;

/** Blocks `overwing standards export` writes, markers included, as one-based line ranges. */
export function generatedRanges(text: string): ReadonlyArray<AgentContextGeneratedRange> {
  const ranges: AgentContextGeneratedRange[] = [];
  let start: number | null = null;
  text.split("\n").forEach((line, index) => {
    if (start === null && OPEN_MARKER.test(line)) start = index + 1;
    else if (start !== null && CLOSE_MARKER.test(line)) {
      ranges.push({ startLine: start, endLine: index + 1 });
      start = null;
    }
  });
  return ranges;
}

const generatedBlocks = (text: string) => {
  const lines = text.split("\n");
  return generatedRanges(text).map((range) =>
    lines.slice(range.startLine - 1, range.endLine).join("\n"),
  );
};

export const sha256 = (text: string) =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const within = (root: string, file: string) => {
  const relative = NodePath.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * Why a discovered source stays read-only here, or null when Save may replace it. The file
 * itself must be a single-link regular Markdown file; links resolve before this check.
 */
export const readOnlyReason = Effect.fn("AgentContext.readOnlyReason")(function* (
  realPath: string,
  home: string,
  isServerInternal: (file: string) => Effect.Effect<boolean>,
) {
  if (!/\.md$/i.test(realPath)) return "Only Markdown sources are edited here.";
  if (
    isCredentialPath(realPath, home) ||
    realPath.split(NodePath.sep).includes(".git") ||
    (yield* isServerInternal(realPath))
  )
    return "Credential, state, or Git metadata path.";
  const stat = yield* Effect.promise(() => NodeFSP.lstat(realPath).catch(() => null));
  if (stat === null || !stat.isFile()) return "Not a regular file.";
  if (stat.nlink !== 1) return "Has other hard links, so saving would split them.";
  if (stat.size > MAX_READ_BYTES) return "Larger than 256 KiB.";
  return null;
});

export interface SaveRequest {
  readonly realPath: string;
  readonly contents: string;
  readonly expectedSha256: string;
}

const refused = (message: string) => new AgentContextError({ message, reason: "refused" });

/**
 * Replaces one source file the caller just rediscovered as editable. A file that changed since
 * the editor loaded it is reported as a conflict and left alone, as is an edit to generated text.
 */
export const saveSource = Effect.fn("AgentContext.saveSource")(function* (
  request: SaveRequest,
  editable: ReadonlySet<string>,
) {
  if (!NodePath.isAbsolute(request.realPath) || !editable.has(request.realPath))
    return yield* refused("This file is not an editable source for this provider and project.");
  // A symlink planted after discovery would redirect the write.
  const resolved = yield* Effect.promise(() =>
    NodeFSP.realpath(request.realPath).catch(() => null),
  );
  if (resolved !== request.realPath)
    return yield* refused("This path no longer resolves to the discovered file.");
  const current = yield* readBounded(request.realPath).pipe(
    Effect.mapError(
      (cause) => new AgentContextError({ message: cause.message, reason: "failed", cause }),
    ),
  );
  if (sha256(current) !== request.expectedSha256)
    return yield* new AgentContextError({
      message: "The file changed on disk since it was opened. Reload it, then reapply your edit.",
      reason: "conflict",
    });
  const before = generatedBlocks(current);
  const after = generatedBlocks(request.contents);
  if (before.length !== after.length || before.some((block, index) => block !== after[index]))
    return yield* refused(
      "Generated standards blocks are read-only. Edit the cards, then run overwing standards export.",
    );
  yield* Effect.tryPromise({
    try: () => replaceHostFile(request.realPath, request.contents),
    catch: (cause) =>
      new AgentContextError({ message: "Could not save the file.", reason: "failed", cause }),
  });
  return { sha256: sha256(request.contents) };
});

/** Paths inside `repoRoot`, relative to it, or a refusal naming the first that is not. */
export const repoRelativePaths = (repoRoot: string, realPaths: ReadonlyArray<string>) => {
  const outside = realPaths.find((file) => !within(repoRoot, file) || file === repoRoot);
  return outside === undefined
    ? Effect.succeed(realPaths.map((file) => NodePath.relative(repoRoot, file)))
    : Effect.fail(refused(`${outside} is not inside ${repoRoot}.`));
};
