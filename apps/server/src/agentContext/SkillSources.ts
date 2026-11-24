import {
  ClaudeSettings,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { discoverClaudeSkillCandidates } from "../provider/Drivers/ClaudeSkills.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { describeSkills, type SkillRow } from "./skillProvenance.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export interface SkillSourcesInput {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly entry: ProviderInstanceConfig | undefined;
  readonly cwd: string | null;
  readonly configDir: string;
}

export interface SkillSourcesResult {
  /** `exact`: discovered as the provider does. `estimate`: the provider's report, listing format assumed. */
  readonly support: "exact" | "estimate" | "unsupported";
  readonly skills: ReadonlyArray<SkillRow>;
}

/** The skills a provider instance offers in a folder, with where each one comes from. */
export class SkillSources extends Context.Service<
  SkillSources,
  { readonly list: (input: SkillSourcesInput) => Effect.Effect<SkillSourcesResult> }
>()("t3/agentContext/SkillSources") {}

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  return SkillSources.of({
    list: Effect.fn("SkillSources.list")(function* (input) {
      const home = yield* HostProcess.HomeDirectory;
      const locations = {
        driver: input.driver,
        home,
        configDir: input.configDir,
        cwd: input.cwd,
      };
      // Claude's own roots, read directly: the registry keeps only the copy that wins a name.
      if (input.driver === "claudeAgent") {
        const settings = decodeClaudeSettings(input.entry?.config ?? {});
        if (settings._tag === "None") return { support: "unsupported", skills: [] };
        const env = yield* mergeProviderInstanceEnvironment(
          input.entry?.environment,
          yield* HostProcess.Environment,
        );
        const candidates = yield* provide(
          discoverClaudeSkillCandidates(settings.value, input.cwd ?? undefined, env),
        );
        return { support: "exact", skills: yield* provide(describeSkills(candidates, locations)) };
      }
      if (input.cwd === null) return { support: "unsupported", skills: [] };
      const providers = yield* registry.refreshWorkspaceSnapshot({
        instanceId: input.instanceId,
        cwd: input.cwd,
      });
      const snapshot = providers
        .find((provider) => provider.instanceId === input.instanceId)
        ?.workspaceSnapshots?.find((entry) => entry.cwd === input.cwd);
      if (snapshot === undefined || snapshot.skills.length === 0)
        return { support: "unsupported", skills: [] };
      const skills = yield* provide(
        describeSkills(
          snapshot.skills.map((skill) => ({ skill, shadowed: false })),
          locations,
        ),
      );
      return { support: input.driver === "codex" ? "exact" : "estimate", skills };
    }),
  });
});

export const layer = Layer.effect(SkillSources, make);
