import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "@t3tools/provider-core/server/textGenerationUtils";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const layerClaudeTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
function makeFakeClaudeBinary(dir: string, lifecyclePort?: number) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const binDir = path.join(dir, "bin");
    const fixturePath = yield* path.fromFileUrl(
      new URL("./testing/ClaudeTextGeneration.fixture.mjs", import.meta.url),
    );
    const source = yield* fs.readFileString(fixturePath);
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source:
        lifecyclePort === undefined
          ? source
          : `if (process.argv.includes("auth")) {
              process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}');
              process.exit(0);
            }
            process.on("SIGTERM", () => {}); ${processProbeSource(lifecyclePort)}`,
    });
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    rejectsNoSessionPersistence?: boolean;
    lifecyclePort?: number;
    subscriptionType?: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    cwdMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir, input.lifecyclePort);
    const pathDelimiter = (yield* HostProcess.isWindows) ? ";" : ":";
    const hostEnv = yield* HostProcess.Environment;
    const fakeClaudeEnv: Record<string, string | undefined> = {
      T3_FAKE_CLAUDE_OUTPUT: input.output,
      T3_FAKE_CLAUDE_SUBSCRIPTION_TYPE: input.subscriptionType,
      T3_FAKE_CLAUDE_REJECTS_NO_SESSION_PERSISTENCE: input.rejectsNoSessionPersistence
        ? "1"
        : undefined,
      T3_FAKE_CLAUDE_EXIT_CODE: input.exitCode === undefined ? undefined : String(input.exitCode),
      T3_FAKE_CLAUDE_STDERR: input.stderr,
      T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN: input.argsMustContain,
      T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN: input.argsMustNotContain,
      T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN: input.stdinMustContain,
      T3_FAKE_CLAUDE_CWD_MUST_NOT_BE: input.cwdMustNotBe,
      T3_FAKE_CLAUDE_CWD_MUST_BE: input.cwdMustBe,
      T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE: input.configDirMustBe,
    };
    const environment: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(hostEnv).filter(([name]) => !name.startsWith("T3_FAKE_CLAUDE_")),
      ),
      ...Object.fromEntries(
        Object.entries(fakeClaudeEnv).filter(([, value]) => value !== undefined),
      ),
      PATH: `${binDir}${pathDelimiter}${hostEnv.PATH ?? ""}`,
    };

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      environment,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(layerClaudeTextGenerationTest)("ClaudeTextGeneration", (it) => {
  const nativeInput = {
    cwd: process.cwd(),
    sourceDriver: ProviderDriverKind.make("claudeAgent"),
    nativeSessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    nativeTurnId: "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb",
    modelSelection: createModelSelection(
      ProviderInstanceId.make("claudeAgent"),
      SYNTHETIC_CLAUDE_CAPABLE_MODEL,
      [{ id: "effort", value: "high" }],
    ),
  };

  it.effect("summarizes a bounded Claude fork without allowing a persistent retry", () =>
    Effect.gen(function* () {
      const output = JSON.stringify({
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "The migration is ready.",
        session_id: "cccccccc-cccc-4ccc-accc-cccccccccccc",
      });
      yield* withFakeClaudeEnv(
        {
          output,
          argsMustContain: `--resume ${nativeInput.nativeSessionId} --resume-session-at ${nativeInput.nativeTurnId} --fork-session --no-session-persistence --safe-mode`,
          argsMustNotContain: "--json-schema",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            expect(yield* textGeneration.generateNativeHandoffSummary!(nativeInput)).toEqual({
              summary: "The migration is ready.",
            });
          }),
      );
      yield* withFakeClaudeEnv({ output, rejectsNoSessionPersistence: true }, (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateNativeHandoffSummary!(nativeInput).pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
        }),
      );
    }),
  );

  it.effect("declines native summary when Claude can load organization policy", () =>
    withFakeClaudeEnv({ output: "", subscriptionType: "enterprise" }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* textGeneration.generateNativeHandoffSummary!(nativeInput).pipe(
          Effect.flip,
        );
        expect(error.detail).toContain("managed policy");
      }),
    ),
  );

  it.effect("kills the native Claude summary process when its request is interrupted", () =>
    Effect.gen(function* () {
      const probe = yield* makeProcessProbe;
      yield* withFakeClaudeEnv({ output: "", lifecyclePort: probe.port }, (textGeneration) =>
        Effect.gen(function* () {
          const request = yield* textGeneration.generateNativeHandoffSummary!(nativeInput).pipe(
            Effect.forkScoped,
          );
          yield* probe.started;
          const cancellation = yield* Fiber.interrupt(request).pipe(Effect.forkScoped);
          yield* probe.exited;
          yield* Fiber.join(cancellation);
        }),
      );
    }),
  );

  it.effect("caps a context review outside the checkout and disables MCP tools", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { findings: [] }, total_cost_usd: 0.0042 }),
        argsMustContain: "--max-budget-usd 0.05 --max-turns 2",
        cwdMustNotBe: process.cwd(),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateMonitoringReview!({
              cwd: process.cwd(),
              prompt: "Review bounded context records",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                SYNTHETIC_CLAUDE_CAPABLE_MODEL,
              ),
              maxOutputTokens: 3000,
              maxBudgetUsd: 0.05,
            }),
          ).toEqual({ findings: [], costUsd: 0.0042 });
        }),
    ),
  );

  it.effect("keeps standards reviews in the project to load CLAUDE.md", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { findings: [] } }),
        cwdMustBe: process.cwd(),
      },
      (textGeneration) =>
        textGeneration.generateMonitoringReview!({
          cwd: process.cwd(),
          prompt: "Review selected standards",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          ),
        }),
    ),
  );

  it.effect.each([
    {
      label: "CLI error",
      output: { is_error: true, result: "Budget exceeded", total_cost_usd: 0.05 },
      exitCode: 1,
    },
    {
      label: "invalid structured output",
      output: { structured_output: { invalid: true }, total_cost_usd: 0.0042 },
      exitCode: 0,
    },
  ])("reports model cost after $label", ({ output, exitCode }) =>
    withFakeClaudeEnv({ output: JSON.stringify(output), exitCode }, (textGeneration) =>
      Effect.gen(function* () {
        let cost: number | undefined;
        const result = yield* textGeneration.generateMonitoringReview!({
          cwd: process.cwd(),
          prompt: "Review context",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            SYNTHETIC_CLAUDE_CAPABLE_MODEL,
          ),
          onCost: (value) => {
            cost = value;
          },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(cost).toBe(output.total_cost_usd);
      }),
    ),
  );

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"disableAllHooks":true,"fastMode":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("sends thread title instructions to the provider prompt", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        stdinMustContain: "Title instructions from the user:\nUse two to four words.",
      },
      (textGeneration) =>
        textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate reconnect failures",
          instructions: "Use two to four words.",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
          },
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("passes --settings from the instance launch args to Claude text generation", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Use instance settings",
          },
        }),
        argsMustContain: `"env":{"ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-a"}`,
        claudeConfig: {
          launchArgs: `--settings '{"env":{"ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-a"}}'`,
        },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "thread title",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe(sanitizeThreadTitle("Use instance settings"));
        }),
    ),
  );

  it.effect("retries without --no-session-persistence when the Claude CLI rejects it", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        rejectsNoSessionPersistence: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate reconnect failures",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Reconnect failures");
        }),
    ),
  );

  it.effect.each([
    { verbose: false, label: "normal" },
    { verbose: true, label: "verbose" },
  ])("unwraps a JSON title in $label Claude output", ({ verbose }) => {
    const result = {
      type: "result",
      structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
    };
    return withFakeClaudeEnv(
      { output: JSON.stringify(verbose ? [result] : result) },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
        }),
    );
  });

  it.effect.each([
    { previousTitle: undefined, label: "generating" },
    { previousTitle: "Old thread title", label: "regenerating" },
  ])("reads the result from verbose Claude output when $label a title", ({ previousTitle }) =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
          { type: "user", message: { content: [] } },
          { type: "rate_limit_event" },
          {
            type: "result",
            subtype: "success",
            result: '{"title":"Refresh ev-stg APP ASG Instances"}',
            structured_output: { title: "Refresh ev-stg APP ASG Instances" },
          },
        ]),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            previousTitle,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
        }),
    ),
  );

  it.effect.each([
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const)("rejects verbose Claude output with %s", ([, output]) =>
    withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error._tag).toBe("TextGenerationError");
      }),
    ),
  );

  const apiError = "API Error: 400 Model blocked by guardrail: 4 endpoints excluded";
  const wrapperNotice = "Using the OpenRouter credential from the global credential file.";
  const structuredOutputError = "Failed to provide valid structured output after 5 attempts";
  const structuredOutputFailure = {
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    errors: [structuredOutputError],
  };
  it.effect.each([
    [
      "the errors list of a result with no result text",
      JSON.stringify(structuredOutputFailure),
      structuredOutputError,
    ],
    [
      "the errors list from verbose output",
      JSON.stringify([{ type: "system", subtype: "init" }, structuredOutputFailure]),
      structuredOutputError,
    ],
    [
      "the errors list without CLI telemetry",
      JSON.stringify({
        ...structuredOutputFailure,
        subtype: "error_during_execution",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a", apiError],
      }),
      apiError,
    ],
    [
      "the stdout error over a stderr notice",
      JSON.stringify({ is_error: true, api_error_status: 400, result: apiError }),
      apiError,
    ],
    [
      "the verbose stdout error over a stderr notice",
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", is_error: true, result: apiError },
        { type: "result", is_error: true, result: " " },
      ]),
      apiError,
    ],
    ["stderr when stdout has no error", "not json", wrapperNotice],
    [
      "a stdout error naming --no-session-persistence without retrying",
      JSON.stringify({
        is_error: true,
        result: "error: unknown option '--no-session-persistence'",
      }),
      "error: unknown option '--no-session-persistence'",
    ],
  ] as const)("reports %s when the Claude CLI fails", ([, output, expected]) =>
    withFakeClaudeEnv({ output, stderr: wrapperNotice, exitCode: 1 }, (textGeneration) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          }),
        );

        expect(error.detail).toBe(`Claude CLI command failed: ${expected}`);
      }),
    ),
  );

  it.effect("does not report the raw result JSON when a failed run writes nothing to stderr", () =>
    withFakeClaudeEnv(
      { output: JSON.stringify(structuredOutputFailure), exitCode: 1 },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error.detail).toBe(`Claude CLI command failed: ${structuredOutputError}`);
        }),
    ),
  );
});
