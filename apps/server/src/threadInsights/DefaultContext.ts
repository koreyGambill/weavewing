import {
  type DefaultContextGetInput,
  type DefaultContextItem,
  type DefaultContextItemInput,
  type DefaultContextItemText,
  type DefaultContextPreview,
  type InstructionFootprint,
  ThreadInsightsError,
} from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as ServerConfig from "../config.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as McpToolCatalog from "../mcp/McpToolCatalog.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { SCRATCH_FOLDER_CONTEXT } from "../orchestration-v2/ProviderTurnStartService.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { codexDefaultReasoningEffortOverride } from "../provider/CodexProvider.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SkillSources } from "../agentContext/SkillSources.ts";
import { skillListingText } from "../agentContext/skillProvenance.ts";
import { providerConfigDir } from "./InstructionFileAllowlist.ts";
import { notVisibleFor, t3ContextParts, toolExposure } from "./defaultContextParts.ts";
import {
  InstructionFootprints,
  type PreparedContextPart,
  splitPreparedContext,
} from "./InstructionFootprints.ts";
import {
  FILE_CONVENTIONS,
  fileStatus,
  MAX_READ_BYTES,
  readBounded,
  reconcileFiles,
  type ResolvedFile,
  resolveInstructionFiles,
} from "./instructionFiles.ts";

export class DefaultContext extends Context.Service<
  DefaultContext,
  {
    readonly preview: (
      input: DefaultContextGetInput,
    ) => Effect.Effect<DefaultContextPreview, ThreadInsightsError>;
    readonly itemText: (
      input: DefaultContextItemInput,
    ) => Effect.Effect<DefaultContextItemText, ThreadInsightsError>;
  }
>()("t3/threadInsights/DefaultContext") {}

const DIRECT_TOOLS = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
const FILE_SCOPE_LABELS: Record<ResolvedFile["scope"], string> = {
  global: "User or managed file",
  project: "Project file",
  rule: "Rule file",
  import: "@ import",
  link: "Linked, read on demand",
};
const tokens = (bytes: number) => Math.ceil(bytes / 4);

/** Whitespace between sections counts toward the total but is not worth its own row. */
function foldSeparators(parts: ReadonlyArray<PreparedContextPart>) {
  const folded: PreparedContextPart[] = [];
  let carry = "";
  for (const part of parts) {
    if (part.text.trim() === "") {
      const previous = folded.pop();
      if (previous === undefined) carry += part.text;
      else folded.push(withText(previous, previous.text + part.text));
      continue;
    }
    folded.push(carry ? withText(part, carry + part.text) : part);
    carry = "";
  }
  return folded;
}
const withText = (part: PreparedContextPart, text: string): PreparedContextPart => {
  const bytes = Buffer.byteLength(text, "utf8");
  return { ...part, text, bytes, estimatedTokens: Math.ceil(bytes / 4) };
};
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const failure = (message: string) => (cause: unknown) =>
  new ThreadInsightsError({ message, cause });

type Loader = Effect.Effect<string>;
// Advertised schemas are plain JSON the MCP server already serialized for tools/list.
const schemaText = (schema: unknown) => JSON.stringify(schema ?? {}, null, 2);

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const footprints = yield* InstructionFootprints;
  const appContext = yield* McpAppModelContext.McpAppModelContext;
  const folders = yield* Effect.serviceOption(ManagedProjectFolders);
  const projects = yield* ProjectService;
  const instances = yield* ProviderInstanceRegistry;
  const settings = yield* ServerSettingsService;
  const mcpSessions = yield* McpProviderSessions;
  const catalog = yield* McpToolCatalog.McpToolCatalog;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const skillSources = yield* SkillSources;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const serverConfig = yield* ServerConfig.ServerConfig;
  const isServerInternal = yield* makeIsServerInternalPath;

  const resolve = Effect.fn("DefaultContext.resolve")(function* (input: DefaultContextGetInput) {
    const draft = input.draft;
    const records =
      draft === undefined
        ? yield* orchestrator
            .getThreadRecords(input.threadId, ["runs"])
            .pipe(Effect.mapError(failure("Could not load the thread.")))
        : undefined;
    const thread = records?.thread;
    if (thread?.deletedAt != null)
      return yield* new ThreadInsightsError({ message: "This thread was deleted." });
    const projectId = thread?.projectId ?? draft!.projectId;
    const project = yield* projects
      .getById(projectId, { includeDeleted: true })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (draft !== undefined && Option.isNone(project))
      return yield* new ThreadInsightsError({ message: "This draft's project no longer exists." });
    // A draft's folder comes from the client: only the project root or a known worktree counts.
    if (
      draft?.worktreePath &&
      draft.worktreePath !== Option.getOrUndefined(project)?.workspaceRoot &&
      !(yield* knownWorkspaces.assertContains(draft.worktreePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ))
    )
      return yield* new ThreadInsightsError({
        message: "This draft's folder is not a known workspace.",
      });
    const projectDefault =
      draft === undefined || input.providerInstanceId !== undefined
        ? undefined
        : (yield* settings.getSettings.pipe(Effect.option)).pipe(
            Option.flatMap((value) =>
              Option.fromNullishOr(
                resolveProjectSettings(value, projectId, Option.getOrUndefined(project)).settings
                  .defaultModelSelection,
              ),
            ),
            Option.getOrUndefined,
          );
    const selection = thread?.modelSelection ?? projectDefault;
    const instanceId = input.providerInstanceId ?? selection?.instanceId;
    if (instanceId === undefined)
      return yield* new ThreadInsightsError({ message: "Pick a model to preview its context." });
    const sameInstance = instanceId === selection?.instanceId;
    const model = input.model ?? (sameInstance ? selection!.model : "");
    const instance = yield* instances.getInstance(instanceId);
    const driver = instance?.driverKind ?? "";
    const cwd =
      (thread?.worktreePath ?? draft?.worktreePath) ||
      (Option.getOrUndefined(project)?.workspaceRoot ?? null);

    const items: DefaultContextItem[] = [];
    const loaders = new Map<string, Loader>();
    const notes: string[] = [];
    const push = (item: DefaultContextItem, load?: Loader) => {
      items.push(item);
      if (load !== undefined) loaders.set(item.id, load);
    };

    const lastRun = records?.runs.toSorted((a, b) => a.ordinal - b.ordinal).at(-1);
    const lastFootprint: InstructionFootprint | undefined =
      lastRun === undefined
        ? undefined
        : (yield* footprints
            .list(input.threadId, lastRun.id)
            .pipe(Effect.orElseSucceed(() => []))).at(-1);
    const footprint = lastFootprint?.driver === driver ? lastFootprint : undefined;

    const session = draft === undefined ? yield* mcpSessions.read(input.threadId) : undefined;
    if (session === undefined)
      notes.push(
        "No live session: assumes T3 tools attach with browser tools and no device tools.",
      );
    const effort =
      sameInstance && selection !== undefined
        ? getModelSelectionStringOptionValue(selection, "reasoningEffort")
        : undefined;
    const t3 = t3ContextParts({
      driver,
      model,
      reasoningEffort:
        driver === "codex" ? (effort ?? codexDefaultReasoningEffortOverride(model)) : effort,
      interactionMode: thread?.interactionMode ?? draft!.interactionMode,
      hasT3Mcp: true,
      browserTools: session?.browserToolsAvailable ?? true,
      deviceTools: session?.capabilities?.has("device") ?? false,
    });
    const addParts = (
      group: { delivery: DefaultContextItem["delivery"]; source: string },
      entries: ReadonlyArray<{ key: string; text: string }>,
      idPrefix: string,
    ) => {
      for (const part of foldSeparators(splitPreparedContext(entries))) {
        push(
          {
            id: `${idPrefix}:${part.category}:${part.key}:${part.label}`,
            category: part.category,
            label: part.label,
            source: group.source,
            delivery: group.delivery,
            bytes: part.bytes,
            estimatedTokens: part.estimatedTokens,
            counted: true,
            readable: true,
          },
          Effect.succeed(part.text),
        );
      }
    };
    for (const [index, group] of t3.groups.entries()) addParts(group, group.entries, `t3${index}`);

    const apps =
      draft === undefined
        ? (yield* appContext.forThread(input.threadId).pipe(Effect.orElseSucceed(() => []))).map(
            (entry) => ({
              key: `mcp_app_${entry.itemId.replace(/[^\w.-]/g, "_")}`,
              text: entry.text,
            }),
          )
        : [];
    const scratch =
      Option.isSome(folders) && (yield* folders.value.isScratchProject(projectId, cwd));
    addParts(
      { delivery: "every-turn", source: "App context T3 adds to each turn" },
      [...apps, ...(scratch ? [SCRATCH_FOLDER_CONTEXT] : [])],
      "app",
    );

    const convention = FILE_CONVENTIONS[driver];
    const home = yield* HostProcess.HomeDirectory;
    const entry = (yield* settings.getSettings.pipe(Effect.option)).pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.providerInstances[instanceId])),
      Option.getOrUndefined,
    );
    const configDir = yield* providerConfigDir(driver, entry, home).pipe(
      Effect.provideService(Path.Path, path),
    );
    if (convention !== undefined && cwd !== null) {
      const resolved = yield* resolveInstructionFiles(
        convention,
        cwd,
        {
          home,
          platform: yield* HostProcess.Platform,
          configDir,
          worktreesDir: serverConfig.worktreesDir,
        },
        (file) => isServerInternal(file).pipe(Effect.orElseSucceed(() => true)),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      for (const file of reconcileFiles(resolved.files, footprint?.instructionSources)) {
        const readable = file.status === "expected" && !file.unexpected;
        const linked = file.linkedFrom !== undefined;
        const status = fileStatus(file);
        push(
          {
            id: `file:${file.path}`,
            category: "files",
            label: file.path,
            source:
              file.status === "not-read"
                ? "Outside the instruction folders, not read"
                : file.status === "secret"
                  ? "Credential or state file, not read"
                  : FILE_SCOPE_LABELS[file.scope],
            delivery: linked ? "on-demand" : "session-start",
            bytes: file.bytes,
            estimatedTokens: tokens(file.bytes),
            counted: file.status === "expected" && !linked,
            readable,
            ...(file.depth > 0 ? { depth: file.depth } : {}),
            ...(linked ? { parentId: `file:${file.linkedFrom}` } : {}),
            // A file read on demand is never expected to load with the session.
            ...(linked && (status === "expected" || status === "not-loaded") ? {} : { status }),
          },
          readable
            ? readBounded(file.realPath, { singleLink: true }).pipe(Effect.orElseSucceed(() => ""))
            : undefined,
        );
      }
      const projectBytes = resolved.files
        .filter((file) => file.scope === "project")
        .reduce((sum, file) => sum + file.bytes, 0);
      if (driver === "codex" && projectBytes > CODEX_PROJECT_DOC_MAX_BYTES)
        notes.push(
          `Codex reads only the first 32 KiB of project instructions; these total ${Math.ceil(projectBytes / 1024)} KiB.`,
        );
      if (driver === "claudeAgent" && resolved.insideHome)
        notes.push("Claude Code also reads CLAUDE.md files above $HOME; this preview stops there.");
    }

    const skills = yield* skillSources.list({ instanceId, driver, entry, cwd, configDir });
    for (const skill of skills.skills) {
      const also = skill.duplicates.length > 0 ? ` · also ${skill.duplicates.join(", ")}` : "";
      push(
        {
          id: `skill:${skill.name}:${skill.path}`,
          category: "skills",
          label: skill.name,
          source: `${skill.origin.label}${skill.origin.detail ? ` (${skill.origin.detail})` : ""}${skill.shadowed ? " · shadowed, never loads" : skill.listed ? "" : " · hidden from the model"}${also}`,
          delivery: skill.listed ? "every-turn" : "on-demand",
          bytes: skill.listingBytes,
          estimatedTokens: skill.listingTokens,
          counted: skill.listed,
          readable: true,
        },
        Effect.succeed(
          skillListingText(driver, {
            name: skill.name,
            path: skill.path,
            enabled: true,
            ...(skill.description ? { description: skill.description } : {}),
          }),
        ),
      );
    }
    if (skills.support === "estimate")
      notes.push(
        "Skill listing sizes assume the provider lists each skill as name and description.",
      );

    const exposure = toolExposure(driver);
    const tools = t3.support === "unsupported" ? [] : yield* catalog.list;
    if (t3.support !== "unsupported" && tools.length === 0)
      notes.push("The T3 tool list is not available yet.");
    if (exposure === "names" && tools.length > 0) {
      const names = tools.map((tool) => tool.name).join("\n");
      const bytes = byteLength(names);
      push(
        {
          id: "tools:names",
          category: "tools",
          label: `${tools.length} deferred tool names`,
          source: "Claude Code lists MCP tools by name and loads one through ToolSearch",
          delivery: "every-turn",
          bytes,
          estimatedTokens: tokens(bytes),
          counted: true,
          readable: true,
        },
        Effect.succeed(names),
      );
    }
    for (const tool of tools) {
      const schema = schemaText(tool.inputSchema);
      const text = `${tool.description}\n\n${schema}`;
      const bytes = byteLength(tool.name) + byteLength(tool.description) + byteLength(schema);
      const listed = exposure === "all" || (exposure === "direct" && DIRECT_TOOLS.has(tool.name));
      push(
        {
          id: `tool:${tool.name}`,
          category: "tools",
          label: tool.name,
          source: listed ? "Description and schema" : "Loads on demand through tool search",
          delivery: listed ? "every-turn" : "on-demand",
          bytes,
          estimatedTokens: tokens(bytes),
          counted: listed,
          readable: true,
        },
        Effect.succeed(text),
      );
    }

    if (instance === undefined) notes.push("This provider instance is not configured here.");
    return {
      preview: {
        threadId: input.threadId,
        providerInstanceId: instanceId,
        projectId,
        driver,
        model,
        cwd,
        support: t3.support,
        filesSupported: convention !== undefined,
        notes,
        items,
        notVisible: notVisibleFor(driver, skills.support !== "unsupported"),
        lastTurn:
          lastFootprint === undefined
            ? null
            : {
                capturedAt: lastFootprint.capturedAt,
                model: lastFootprint.model,
                reportsFiles: footprint?.instructionSources !== undefined,
                injectedBytes: lastFootprint.parts.reduce((sum, part) => sum + part.bytes, 0),
              },
        estimateMethod:
          "UTF-8 bytes divided by four, rounded up; not tokenizer counts. Instruction files are what the provider documents loading for this folder, not what it reported.",
      } satisfies DefaultContextPreview,
      loaders,
    };
  });

  type Resolved = Effect.Success<ReturnType<typeof resolve>>;
  // Expanding an item reuses the preview it came from for a short while; previews always resolve.
  const recent = new Map<string, { readonly at: number; readonly resolved: Resolved }>();
  const resolveKey = ({ itemId: _itemId, ...input }: DefaultContextItemInput) =>
    JSON.stringify(input);
  const remember = (input: DefaultContextGetInput, resolved: Resolved) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((at) => {
        if (recent.size > 32) recent.clear();
        recent.set(resolveKey({ ...input, itemId: "" }), { at, resolved });
        return resolved;
      }),
    );

  return DefaultContext.of({
    preview: Effect.fn("DefaultContext.preview")(function* (input) {
      return (yield* remember(input, yield* resolve(input))).preview;
    }),
    itemText: Effect.fn("DefaultContext.itemText")(function* (input) {
      const cached = recent.get(resolveKey(input));
      const { preview, loaders } =
        cached !== undefined && (yield* Clock.currentTimeMillis) - cached.at < 30_000
          ? cached.resolved
          : yield* remember(input, yield* resolve(input));
      const load = loaders.get(input.itemId);
      if (load === undefined)
        return yield* new ThreadInsightsError({ message: "This item has no readable text." });
      const bytes = preview.items.find((item) => item.id === input.itemId)?.bytes ?? 0;
      return { itemId: input.itemId, text: yield* load, truncated: bytes > MAX_READ_BYTES };
    }),
  });
});

export const layer = Layer.effect(DefaultContext, make);
