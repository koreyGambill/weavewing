import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type ClaudeSettings, TextGenerationError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { NATIVE_HANDOFF_SUMMARY_PROMPT } from "@t3tools/provider-core/server/textGenerationPrompts";
import { compileClaudeModelSelection } from "../claudeModelOptions.ts";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "../provider/Drivers/ClaudeHome.ts";
import { customClaudeApiEndpointHost } from "../provider/Drivers/ClaudeSkills.ts";
import { readClaudeLaunchArgSettings } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
const CLAUDE_NATIVE_SUMMARY_TIMEOUT_MS = 90_000;
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const decodeNativeSummary = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      subtype: Schema.Literal("success"),
      is_error: Schema.Literal(false),
      num_turns: Schema.Literal(1),
      result: Schema.String,
      session_id: Schema.String.check(Schema.isPattern(CLAUDE_SESSION_ID)),
    }),
  ),
);
const decodeClaudeAuthStatus = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      loggedIn: Schema.Literal(true),
      authMethod: Schema.String,
      apiProvider: Schema.Literal("firstParty"),
      subscriptionType: Schema.optionalKey(Schema.String),
    }),
  ),
);
/** `--tools` takes bare names; patterns go in the allow list. */
const CLAUDE_INVESTIGATION_TOOLS = "Read,Grep,Glob,Bash";
/** In dontAsk mode every call outside this list, Bash included, is refused. */
const CLAUDE_INVESTIGATION_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
].join(",");
// Denies override allows; block git --output/-o because allowed trailing args can otherwise write anywhere.
const CLAUDE_INVESTIGATION_DENIED = ["Bash(git * --output*)", "Bash(git * -o *)"].join(",");

const NO_SESSION_PERSISTENCE = "--no-session-persistence";
// Claude Code before 2.0.63 exits with this on stderr; those runs retry without the flag.
const NO_SESSION_PERSISTENCE_REJECTED = `error: unknown option '${NO_SESSION_PERSISTENCE}'`;

const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
  total_cost_usd: Schema.optional(Schema.Number),
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
  total_cost_usd: Schema.optional(Schema.Number),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

// Only `success` results carry `result`; error subtypes such as
// error_max_structured_output_retries report through `errors` instead.
const ClaudeErrorResult = Schema.Struct({
  is_error: Schema.Literal(true),
  result: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(Schema.String)),
});
const isClaudeErrorResult = Schema.is(ClaudeErrorResult);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

// Claude reports JSON errors on stdout; stderr may contain only wrapper notices.
function claudeErrorResult(stdout: string): string | undefined {
  const output = Option.getOrUndefined(decodeJsonOption(stdout));
  const messages: ReadonlyArray<unknown> = Array.isArray(output) ? output : [output];
  return messages
    .filter(isClaudeErrorResult)
    .map((message) =>
      (
        message.result ??
        // error_during_execution mixes CLI telemetry into the list.
        message.errors?.filter((error) => !error.startsWith("[ede_diagnostic]")).join("\n") ??
        ""
      ).trim(),
    )
    .findLast((result) => result.length > 0);
}

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
  routeModelCatalog: (
    catalog: ClaudeModelCatalog,
    cwd: string,
  ) => Effect.Effect<ClaudeModelCatalog> = Effect.succeed,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  const spawnClaude = Effect.fn("ClaudeTextGeneration.spawnClaude")(function* (input: {
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly prompt: string;
  }) {
    const spawn = yield* resolveSpawnCommand(claudeSettings.binaryPath || "claude", input.args, {
      env: input.env,
    });
    const child = yield* commandSpawner
      .spawn(
        ChildProcess.make(spawn.command, spawn.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawn.shell,
          stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
          forceKillAfter: "1 second",
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          normalizeCliError("claude", input.operation, cause, "Failed to spawn Claude CLI process"),
        ),
      );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        readStreamAsString(input.operation, child.stdout),
        readStreamAsString(input.operation, child.stderr),
        child.exitCode.pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              "claude",
              input.operation,
              cause,
              "Failed to read Claude CLI exit code",
            ),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  });

  const encodeJsonForOperation = (
    operation: string,
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  const generateNativeHandoffSummary: NonNullable<
    ProviderTextGeneration["generateNativeHandoffSummary"]
  > = Effect.fn("ClaudeTextGeneration.generateNativeHandoffSummary")(
    function* (input) {
      const operation = "generateNativeHandoffSummary";
      const unavailable = (detail: string) => new TextGenerationError({ operation, detail });
      if (
        !CLAUDE_SESSION_ID.test(input.nativeSessionId) ||
        !CLAUDE_SESSION_ID.test(input.nativeTurnId)
      ) {
        return yield* unavailable("The Claude session has no exact native message boundary.");
      }
      const policy = yield* Effect.tryPromise({
        try: () => resolveSettings({ cwd: input.cwd, settingSources: [] }),
        catch: () => unavailable("Claude's managed settings could not be inspected."),
      });
      const configDirectory = yield* resolveClaudeHomePath(claudeSettings, claudeEnvironment).pipe(
        Effect.provideService(Path.Path, path),
      );
      const managed = yield* Effect.all([
        hasClaudeManagedMcpConfig(),
        fileSystem
          .exists(path.join(configDirectory, "remote-settings.json"))
          .pipe(
            Effect.mapError(() => unavailable("Claude's managed settings could not be inspected.")),
          ),
      ]).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      // Safe mode leaves administrator-managed hooks active.
      if (managed.some(Boolean) || policy.sources.some(({ source }) => source === "managed")) {
        return yield* unavailable("Claude's managed settings prevent verifying tool isolation.");
      }
      const auth = yield* spawnClaude({
        operation,
        cwd: input.cwd,
        env: claudeEnvironment,
        prompt: "",
        args: ["--safe-mode", "auth", "status", "--json"],
      }).pipe(Effect.scoped);
      const account = yield* decodeClaudeAuthStatus(auth.stdout).pipe(
        Effect.mapError(() => unavailable("Claude's account type could not be verified.")),
      );
      const personal =
        account.authMethod === "claude.ai" &&
        (account.subscriptionType === "pro" || account.subscriptionType === "max");
      const customApiKey =
        account.authMethod === "api_key" &&
        customClaudeApiEndpointHost(claudeEnvironment.ANTHROPIC_BASE_URL) !== undefined;
      if (auth.exitCode !== 0 || (!personal && !customApiKey)) {
        return yield* unavailable("Claude's account can receive managed policy at startup.");
      }
      const catalog = yield* routeModelCatalog(yield* scopedModelCatalog, input.cwd);
      const model = compileClaudeModelSelection(input.modelSelection, catalog);
      const settings = yield* encodeJsonForOperation(
        operation,
        { ...model.settings, disableAllHooks: true },
        "Failed to encode Claude CLI settings.",
      );
      const { stdout, exitCode } = yield* spawnClaude({
        operation,
        cwd: input.cwd,
        env: claudeEnvironment,
        prompt: applyClaudePromptEffortPrefix(NATIVE_HANDOFF_SUMMARY_PROMPT, model.promptEffort),
        args: [
          "-p",
          "--output-format",
          "json",
          "--resume",
          input.nativeSessionId,
          "--resume-session-at",
          input.nativeTurnId,
          "--fork-session",
          NO_SESSION_PERSISTENCE,
          "--safe-mode",
          "--disable-slash-commands",
          "--tools",
          "",
          "--strict-mcp-config",
          "--disallowedTools",
          "mcp__*",
          "--settings",
          settings,
          "--permission-mode",
          "dontAsk",
          "--max-turns",
          "1",
          "--model",
          model.apiModelId,
          ...(model.effort ? ["--effort", model.effort] : []),
        ],
      }).pipe(Effect.scoped);
      if (exitCode !== 0) {
        return yield* unavailable("Claude did not complete the isolated session fork.");
      }
      const output = yield* decodeNativeSummary(stdout).pipe(
        Effect.mapError(() => unavailable("Claude returned no successful one-turn summary.")),
      );
      if (output.session_id === input.nativeSessionId) {
        return yield* unavailable("Claude did not return a distinct forked session.");
      }
      return { summary: output.result };
    },
    Effect.timeoutOrElse({
      duration: CLAUDE_NATIVE_SUMMARY_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateNativeHandoffSummary",
            detail: "The native summary request timed out.",
          }),
        ),
    }),
  );

  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    investigate,
    maxOutputTokens,
    maxBudgetUsd,
    onCost,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"] | Scope.Scope
  > {
    const workingDirectory =
      operation === "generateThreadTitle" ||
      operation === "generateMessageSummary" ||
      // Context reviews must reflect only the supplied records, without automatic project loads.
      (operation === "generateMonitoringReview" && maxBudgetUsd !== undefined)
        ? yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "t3code-claude-title-" })
            .pipe(
              Effect.mapError((cause) =>
                normalizeCliError("claude", operation, cause, "Failed to create title directory"),
              ),
            )
        : cwd;
    const catalog = yield* routeModelCatalog(yield* scopedModelCatalog, workingDirectory);
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolveClaudeModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const caps = getClaudeCatalogModelCapabilities(catalog, resolvedModelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: resolvedModelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(resolvedModelSelection, "effort");
    const resolvedEffort = resolveClaudeCatalogEffort(
      catalog,
      resolvedModelSelection.model,
      rawEffortSelection,
    );
    const cliEffort = normalizeClaudeCatalogEffort(
      catalog,
      resolvedEffort,
      resolvedModelSelection.model,
    );
    const ultracode = findDescriptor("ultracode")?.currentValue;
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    // Only a chosen value; otherwise Claude Code's own default applies, as in chat turns.
    const thinking =
      thinkingDescriptor?.type === "boolean"
        ? getModelSelectionBooleanOptionValue(resolvedModelSelection, "thinking")
        : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const launchArgSettings = yield* readClaudeLaunchArgSettings({
      settings: claudeSettings,
      cwd,
      fileSystem,
      path,
    }).pipe(
      Effect.mapError(
        (cause) => new TextGenerationError({ operation, detail: cause.message, cause }),
      ),
    );
    const settings = {
      ...launchArgSettings,
      disableAllHooks: true,
      ...(maxBudgetUsd !== undefined
        ? { alwaysThinkingEnabled: false }
        : typeof thinking === "boolean"
          ? { alwaysThinkingEnabled: thinking }
          : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(typeof ultracode === "boolean" ? { ultracode } : {}),
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Claude CLI settings.",
    );

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* (
      noSessionPersistence: boolean,
    ) {
      const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
      return yield* spawnClaude({
        operation,
        cwd: workingDirectory,
        prompt,
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          ...(investigate
            ? [
                "--tools",
                CLAUDE_INVESTIGATION_TOOLS,
                "--allowedTools",
                CLAUDE_INVESTIGATION_ALLOWED,
                "--disallowedTools",
                CLAUDE_INVESTIGATION_DENIED,
              ]
            : ["--tools", "", "--disallowedTools", "mcp__*"]),
          ...(maxBudgetUsd === undefined
            ? []
            : ["--max-budget-usd", String(maxBudgetUsd), "--max-turns", "2"]),
          "--disable-slash-commands",
          ...(noSessionPersistence ? [NO_SESSION_PERSISTENCE] : []),
          // managed-mcp.json already isolates servers and makes Claude reject this flag.
          ...(managedMcpConfig ? [] : ["--strict-mcp-config"]),
          "--permission-mode",
          "dontAsk",
        ],
        env: {
          ...claudeEnvironment,
          ...(maxOutputTokens === undefined
            ? {}
            : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }),
        },
      });
    });

    const rawStdout = yield* runClaudeCommand(true).pipe(
      Effect.filterOrElse(
        (result) =>
          result.exitCode === 0 || !result.stderr.includes(NO_SESSION_PERSISTENCE_REJECTED),
        () => runClaudeCommand(false),
      ),
      Effect.flatMap(({ stdout, stderr, exitCode }) => {
        const parsed = Option.getOrUndefined(decodeJsonOption(stdout));
        const messages: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [parsed];
        const cost = messages
          .flatMap((message) =>
            typeof message === "object" &&
            message !== null &&
            "total_cost_usd" in message &&
            typeof message.total_cost_usd === "number" &&
            Number.isFinite(message.total_cost_usd) &&
            message.total_cost_usd >= 0
              ? [message.total_cost_usd]
              : [],
          )
          .at(-1);
        if (cost !== undefined) onCost?.(cost);
        if (exitCode === 0) return Effect.succeed(stdout);
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail =
          claudeErrorResult(stdoutDetail) ??
          (stderrDetail.length > 0 ? stderrDetail : stdoutDetail);
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              detail.length > 0
                ? `Claude CLI command failed: ${detail}`
                : `Claude CLI command failed with code ${exitCode}.`,
          }),
        );
      }),
      Effect.scoped,
      Effect.timeoutOption(investigate?.timeoutMs ?? CLAUDE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  return {
    ...TextGenerationOperations.fromRunner(
      "ClaudeTextGeneration",
      <S extends Schema.Top>(request: TextGenerationOperations.Request<S>) =>
        Effect.scoped(runClaudeJson(request)),
    ),
    generateNativeHandoffSummary,
  };
});
