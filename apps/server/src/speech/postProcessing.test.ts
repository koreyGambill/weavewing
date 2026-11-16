import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";

const textGenerationSelection = {
  instanceId: ProviderInstanceId.make("fakeapi"),
  model: "fake-model",
};
const acpSelection = { instanceId: ProviderInstanceId.make("acp_local"), model: "default" };

it.effect("cleanup pinned to a provider that cannot generate text uses the text model", () =>
  Effect.gen(function* () {
    const used = yield* Ref.make<ModelSelection | null>(null);
    const layer = SpeechPostProcessing.layer.pipe(
      Layer.provide(
        Layer.succeed(TextGeneration.TextGeneration, {
          generateTranscriptionPostProcessing: (input: { modelSelection: ModelSelection }) =>
            Ref.set(used, input.modelSelection).pipe(Effect.as({ transcription: "Hello, world." })),
        } as unknown as TextGeneration.TextGeneration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: acpSelection.instanceId,
              driver: "acpRegistry",
              enabled: true,
              installed: true,
              supportsTextGeneration: false,
            },
          ]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [acpSelection.instanceId]: {
              driver: "acpRegistry",
              enabled: true,
              config: { source: "local", commandPath: "acp-agent" },
            },
          },
          textGenerators: {
            [textGenerationSelection.instanceId]: {
              kind: "openaiCompatible",
              baseUrl: "http://127.0.0.1:18999/v1",
              enabled: true,
            },
          },
          textGenerationModelSelection: textGenerationSelection,
          speechPostProcessingModelSelection: acpSelection,
        }),
      ),
      Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({})),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
      yield* postProcessing.process({
        options: {
          speechCustomWords: [],
          speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
        },
        transcript: "um hello world",
        draft: { text: "", selection: { start: 0, end: 0 } },
      } as never);
    }).pipe(Effect.provide(layer));
    const selection = yield* Ref.get(used);
    assert.deepStrictEqual(
      { instanceId: selection?.instanceId, model: selection?.model },
      textGenerationSelection,
    );
  }),
);

const claudeThread = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

it.effect("cleanup follows the thread it was dictated in, not the environment default", () =>
  Effect.gen(function* () {
    const used = yield* Ref.make<ModelSelection | null>(null);
    const threadId = ThreadId.make("thread:dictation");
    const layer = SpeechPostProcessing.layer.pipe(
      Layer.provide(
        Layer.succeed(TextGeneration.TextGeneration, {
          generateTranscriptionPostProcessing: (input: { modelSelection: ModelSelection }) =>
            Ref.set(used, input.modelSelection).pipe(Effect.as({ transcription: "Hello." })),
        } as unknown as TextGeneration.TextGeneration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      ),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (requested) =>
            Effect.succeed(
              requested === threadId
                ? ({
                    projectId: ProjectId.make("project:dictation"),
                    modelSelection: claudeThread,
                  } as never)
                : null,
            ),
        }),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-astra",
          },
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    const clean = (id?: ThreadId) =>
      Effect.gen(function* () {
        const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
        yield* postProcessing.process({
          options: {
            speechCustomWords: [],
            speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
          },
          transcript: "um hello",
          draft: { text: "", selection: { start: 0, end: 0 } },
          ...(id === undefined ? {} : { threadId: id }),
        } as never);
        return yield* Ref.get(used);
      }).pipe(Effect.provide(layer));
    assert.strictEqual((yield* clean(threadId))?.instanceId, "claudeAgent");
    assert.strictEqual((yield* clean())?.instanceId, "codex");
  }),
);

it.effect("threadless cleanup uses the draft's project; an unresolvable thread fails instead", () =>
  Effect.gen(function* () {
    const used = yield* Ref.make<ModelSelection | null>(null);
    const projectId = ProjectId.make("project:draft");
    const layer = SpeechPostProcessing.layer.pipe(
      Layer.provide(
        Layer.succeed(TextGeneration.TextGeneration, {
          generateTranscriptionPostProcessing: (input: { modelSelection: ModelSelection }) =>
            Ref.set(used, input.modelSelection).pipe(Effect.as({ transcription: "Hello." })),
        } as unknown as TextGeneration.TextGeneration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      ),
      Layer.provide(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (requested) =>
            requested === ThreadId.make("thread:broken")
              ? Effect.die("storage unavailable")
              : Effect.succeed(null),
        }),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-astra",
          },
          projectSettingsOverrides: { [projectId]: { defaultModelSelection: claudeThread } },
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    const request = (extra: object) =>
      Effect.gen(function* () {
        yield* Ref.set(used, null);
        const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
        return yield* postProcessing
          .process({
            options: {
              speechCustomWords: [],
              speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
            },
            transcript: "um hello",
            draft: { text: "", selection: { start: 0, end: 0 } },
            ...extra,
          } as never)
          .pipe(Effect.exit);
      }).pipe(Effect.provide(layer));
    assert.isTrue((yield* request({ projectId }))._tag === "Success");
    assert.strictEqual((yield* Ref.get(used))?.instanceId, "claudeAgent");
    for (const threadId of ["thread:gone", "thread:broken"]) {
      const exit = yield* request({ threadId: ThreadId.make(threadId), projectId });
      assert.isTrue(exit._tag === "Failure");
      assert.isNull(yield* Ref.get(used));
    }
  }),
);
