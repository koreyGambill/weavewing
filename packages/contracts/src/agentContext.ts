import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const MAX_COMMAND_WORDS = 8;
const TOOL_NAME_GLOB = /^[\w.:*-]+$/;

/** Null for a usable watcher, else what to fix. */
export function loadWatcherError(watcher: { readonly kind: string; readonly match: string }) {
  const match = watcher.match.trim();
  if (match === "") return "Add words to match.";
  if (watcher.kind === "command")
    return match.split(/\s+/).length > MAX_COMMAND_WORDS
      ? `Use at most ${MAX_COMMAND_WORDS} words.`
      : null;
  return TOOL_NAME_GLOB.test(match)
    ? null
    : "Use letters, digits, _ . : - and * for any run of characters.";
}

/**
 * Marks a tool call as a knowledge load. A `command` watcher matches when its words appear as
 * consecutive words of the shell command; a `tool` watcher matches the tool's name, with `*`
 * standing for any run of characters. Both match in linear time, so no setting can stall the
 * server.
 */
export const LoadWatcher = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  kind: Schema.Literals(["command", "tool"]),
  match: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
}).check(Schema.makeFilter((watcher) => loadWatcherError(watcher) ?? true));
export type LoadWatcher = typeof LoadWatcher.Type;
export const LoadWatchers = Schema.Array(LoadWatcher).check(Schema.isMaxLength(32));

export const DEFAULT_LOAD_WATCHERS: ReadonlyArray<LoadWatcher> = [
  { label: "overwing", kind: "command", match: "overwing search" },
  { label: "overwing", kind: "command", match: "overwing context" },
  { label: "overwing", kind: "command", match: "overwing standards" },
];

export const AgentContextGetInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  projectId: ProjectId,
  /** A thread's checkout of the project; the server accepts only known workspaces. */
  worktreePath: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type AgentContextGetInput = typeof AgentContextGetInput.Type;

const AbsolutePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

/** A line range of generated text inside a source, one-based and inclusive. */
export const AgentContextGeneratedRange = Schema.Struct({
  startLine: NonNegativeInt,
  endLine: NonNegativeInt,
});
export type AgentContextGeneratedRange = typeof AgentContextGeneratedRange.Type;

/** Fields every source row carries: where it really lives and whether that repository holds edits. */
const sourceFields = {
  /** The path the provider names, before symlinks resolve. */
  path: Schema.String,
  realPath: Schema.String,
  linked: Schema.Boolean,
  bytes: NonNegativeInt,
  /** The git work tree holding `realPath`, or null outside one. */
  repoRoot: Schema.NullOr(Schema.String),
  modified: Schema.Boolean,
  editable: Schema.Boolean,
  /** Whether its text can be opened here; credential and server-state files never can. */
  readable: Schema.Boolean,
  /** Why a listed source cannot be edited here. */
  readOnlyReason: Schema.optional(Schema.String),
  generated: Schema.Array(AgentContextGeneratedRange),
};

export const AgentContextInstruction = Schema.Struct({
  ...sourceFields,
  scope: Schema.Literals(["global", "project", "rule", "import", "link"]),
  /** Tokens this file adds to every session, estimated as bytes divided by four. */
  estimatedTokens: NonNegativeInt,
  status: Schema.Literals(["expected", "not-read", "secret"]),
  depth: NonNegativeInt,
  /** The documented path of the file whose markdown link reaches this one. */
  linkedFrom: Schema.optional(Schema.String),
});
export type AgentContextInstruction = typeof AgentContextInstruction.Type;

export const AgentContextSkillOrigin = Schema.Struct({
  kind: Schema.Literals(["user", "project", "plugin", "npx", "codex", "managed", "other"]),
  /** Short name for grouping, such as `User skills` or `mattpocock-skills@1.3.1`. */
  label: Schema.String,
  /** Install source, such as the npx lock's `mattpocock/skills`. */
  detail: Schema.optional(Schema.String),
});
export type AgentContextSkillOrigin = typeof AgentContextSkillOrigin.Type;

export const AgentContextSkill = Schema.Struct({
  ...sourceFields,
  name: Schema.String,
  /** The name without a plugin prefix, which duplicates are matched on. */
  baseName: Schema.String,
  description: Schema.optional(Schema.String),
  origin: AgentContextSkillOrigin,
  /** False when the model never sees it listed: disabled, user-invoked only, or shadowed. */
  listed: Schema.Boolean,
  /** Another source of the same name wins, so this copy never loads. */
  shadowed: Schema.Boolean,
  /** Why the model never sees a skill that is not shadowed: only users invoke it, or it is off. */
  unlisted: Schema.optional(Schema.Literals(["user-only", "off"])),
  listingBytes: NonNegativeInt,
  listingTokens: NonNegativeInt,
  /** Origin labels of the other sources offering a skill with this base name. */
  duplicates: Schema.Array(Schema.String),
});
export type AgentContextSkill = typeof AgentContextSkill.Type;

/** The most changed files an overview lists per repository; Commit takes the rest from a terminal. */
export const AGENT_CONTEXT_MAX_DIRTY = 2000;

export const AgentContextRepo = Schema.Struct({
  root: Schema.String,
  /** Null before the first commit. */
  head: Schema.NullOr(Schema.String),
  /** Null on a detached HEAD. */
  branch: Schema.NullOr(Schema.String),
  /** Every changed or untracked file in the work tree, relative to `root`; Commit offers them all. */
  dirty: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      /** A rename's or copy's earlier path, which the commit takes with `path`. */
      origPath: Schema.optional(Schema.String),
      untracked: Schema.Boolean,
      /** An untracked file whose name looks like a credential, which Commit leaves unchecked. */
      secret: Schema.Boolean,
    }),
  ),
  /** Every changed file, which exceeds `dirty.length` past `AGENT_CONTEXT_MAX_DIRTY`. */
  dirtyCount: NonNegativeInt,
});
export type AgentContextRepo = typeof AgentContextRepo.Type;

export const AgentContextOverview = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: Schema.String,
  projectId: ProjectId,
  cwd: Schema.NullOr(Schema.String),
  instructionsSupported: Schema.Boolean,
  instructions: Schema.Array(AgentContextInstruction),
  /** `unsupported` when the provider reports no skills to T3. */
  skillsSupport: Schema.Literals(["exact", "estimate", "unsupported"]),
  skills: Schema.Array(AgentContextSkill),
  repos: Schema.Array(AgentContextRepo),
  notes: Schema.Array(Schema.String),
});
export type AgentContextOverview = typeof AgentContextOverview.Type;

export const AgentContextReadInput = Schema.Struct({
  ...AgentContextGetInput.fields,
  realPath: AbsolutePath,
});
export type AgentContextReadInput = typeof AgentContextReadInput.Type;

export const AgentContextSourceText = Schema.Struct({
  realPath: Schema.String,
  text: Schema.String,
  sha256: Schema.String,
  generated: Schema.Array(AgentContextGeneratedRange),
});
export type AgentContextSourceText = typeof AgentContextSourceText.Type;

export const AgentContextSaveInput = Schema.Struct({
  ...AgentContextGetInput.fields,
  realPath: AbsolutePath,
  contents: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  /** The hash the editor loaded; a different file on disk is a conflict. */
  expectedSha256: Schema.String.check(Schema.isMaxLength(64)),
});
export type AgentContextSaveInput = typeof AgentContextSaveInput.Type;

export const AgentContextSaveResult = Schema.Struct({ sha256: Schema.String });
export type AgentContextSaveResult = typeof AgentContextSaveResult.Type;

/** Commits changed files of a repository that holds a discovered source, by explicit path. */
export const AgentContextCommitInput = Schema.Struct({
  ...AgentContextGetInput.fields,
  repoRoot: AbsolutePath,
  // Each listed row can name two paths: a rename's new and earlier path.
  realPaths: Schema.Array(AbsolutePath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_CONTEXT_MAX_DIRTY * 2),
  ),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** The HEAD the page showed; null for a repository without commits. */
  expectedHead: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
});
export type AgentContextCommitInput = typeof AgentContextCommitInput.Type;

export const AgentContextCommitResult = Schema.Struct({ commitSha: Schema.String });
export type AgentContextCommitResult = typeof AgentContextCommitResult.Type;

export class AgentContextError extends Schema.TaggedError<AgentContextError>()(
  "AgentContextError",
  {
    message: Schema.String,
    /** `conflict`: the file or HEAD moved since it loaded. `refused`: not a source this page edits. */
    reason: Schema.Literals(["conflict", "refused", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
