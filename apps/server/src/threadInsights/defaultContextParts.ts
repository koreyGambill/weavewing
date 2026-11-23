import type { DefaultContextItem, ProviderInteractionMode } from "@t3tools/contracts";
import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  claudePreparedContextEntries,
  claudeSystemPromptAppend,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { buildCodexAdditionalContext } from "../provider/CodexDeveloperInstructions.ts";
import type { PreparedContext } from "./InstructionFootprints.ts";

export interface T3PartInputs {
  readonly driver: string;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly browserTools: boolean;
  readonly deviceTools: boolean;
}

export interface T3PartGroup {
  readonly delivery: DefaultContextItem["delivery"];
  readonly source: string;
  readonly entries: PreparedContext["entries"];
}

export interface T3Parts {
  readonly support: "exact" | "estimate" | "unsupported";
  readonly groups: ReadonlyArray<T3PartGroup>;
}

const ACP_HARNESS: Readonly<Record<string, string>> = {
  grok: "Grok",
  fx: "fx",
  kiro: "Kiro",
  antigravity: "Antigravity",
  acpRegistry: "acpRegistry",
};

/**
 * What T3 adds before the user's message, built by the same functions each adapter calls.
 * Claude and Codex compose them in one exported function, so they are exact; the others
 * compose inside the adapter and are rebuilt here from the same pieces.
 */
export function t3ContextParts(input: T3PartInputs): T3Parts {
  const group = (
    delivery: T3PartGroup["delivery"],
    source: string,
    ...entries: ReadonlyArray<readonly [string, string]>
  ): T3PartGroup => ({ delivery, source, entries: entries.map(([key, text]) => ({ key, text })) });
  const runtime = (harness: string, reasoningEffort?: string) =>
    buildRuntimeInstructions({ harness, model: input.model, reasoningEffort });
  switch (input.driver) {
    case "claudeAgent": {
      const append = claudeSystemPromptAppend({
        hasT3Mcp: input.hasT3Mcp,
        deviceTools: input.hasT3Mcp && input.deviceTools,
      });
      const entries = claudePreparedContextEntries(append);
      return {
        support: "exact",
        groups: [{ delivery: "every-turn", source: "Claude SDK systemPrompt.append", entries }],
      };
    }
    case "codex": {
      const context = buildCodexAdditionalContext(
        { model: input.model, reasoningEffort: input.reasoningEffort },
        { browser: input.browserTools, device: input.deviceTools },
      );
      const entries = Object.entries(context).map(([key, entry]) => ({ key, text: entry.value }));
      return {
        support: "exact",
        groups: input.hasT3Mcp
          ? [{ delivery: "every-turn", source: "Codex turn/start.additionalContext", entries }]
          : [],
      };
    }
    case "opencode": {
      const orchestration = t3OrchestrationSystemPrompt(input.hasT3Mcp, input.deviceTools);
      const text = [runtime("OpenCode"), ...(orchestration ? [orchestration] : [])].join("\n\n");
      return {
        support: "estimate",
        groups: [group("every-turn", "OpenCode session instructions", ["t3_code_session", text])],
      };
    }
    case "cursor": {
      const prompt = t3OrchestrationPrompt({
        prompt: "",
        hasT3Mcp: input.hasT3Mcp,
        hasDeviceTools: input.deviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
      return {
        support: "estimate",
        groups: [
          group("first-prompt", "Prepended to the first prompt", ["t3_code_prompt", prompt]),
          group("every-turn", "Appended to each prompt", ["t3_code_runtime", runtime("Cursor")]),
        ],
      };
    }
    case "pi": {
      const text = T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim();
      return {
        support: "estimate",
        groups: [group("every-turn", "T3 Pi extension", ["t3_code_orchestration", text])],
      };
    }
    case "muse":
      return {
        support: "estimate",
        groups: [
          group("every-turn", "Each turn's first input", [
            "t3_code_runtime",
            runtime("Muse Code", input.reasoningEffort),
          ]),
        ],
      };
  }
  const harness = ACP_HARNESS[input.driver];
  if (harness === undefined) return { support: "unsupported", groups: [] };
  const prompt = t3AcpPromptWithInstructions({
    prompt: "",
    state: {
      interactionMode: input.interactionMode,
      hasT3Mcp: input.hasT3Mcp,
      hasDeviceTools: input.deviceTools,
    },
  });
  return {
    support: "estimate",
    groups: [
      group(
        "first-prompt",
        "First prompt, resent after compaction or a mode change",
        ["t3_code_prompt", prompt],
        ["t3_code_runtime", runtime(harness)],
      ),
    ],
  };
}

export type ToolExposure = "all" | "names" | "direct";

/** How much of T3's MCP tool list a driver's model sees before it searches. */
export const toolExposure = (driver: string): ToolExposure =>
  driver === "claudeAgent"
    ? "names"
    : driver === "acpRegistry" || driver === "pi"
      ? "direct"
      : "all";

const NOT_VISIBLE_CLAUDE_CODEX: Readonly<
  Record<string, ReadonlyArray<{ readonly label: string; readonly why: string }>>
> = {
  claudeAgent: [
    {
      label: "Claude Code system prompt and built-in tools",
      why: "Set by the CLI preset; T3 only appends.",
    },
    {
      label: "Plugin agents, slash commands and hooks",
      why: "Claude Code lists them from its config folders.",
    },
    {
      label: "Auto memory, output style, hook context and your own MCP servers",
      why: "Loaded inside Claude Code, not reported to T3.",
    },
  ],
  codex: [
    {
      label: "Codex base instructions and built-in tools",
      why: "Part of the model's Codex prompt, not sent through T3.",
    },
    {
      label: "Config developer_instructions and your own MCP servers",
      why: "Codex reads them from its home and config.",
    },
  ],
};

export const notVisibleFor = (driver: string, skillsListed: boolean) =>
  NOT_VISIBLE_CLAUDE_CODEX[driver] ?? [
    {
      label: skillsListed
        ? "The provider's own prompt, tools and instruction files"
        : "The provider's own prompt, tools, skills and instruction files",
      why: "The provider loads them itself; T3 does not resolve them.",
    },
  ];
