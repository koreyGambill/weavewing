// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  InstructionFootprint,
  ThreadInsightsError,
  type InstructionFootprintPart,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  T3_CODE_ORCHESTRATION_SECTIONS,
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_QUESTION_TOOL_INSTRUCTIONS,
  T3_CODE_TRACKED_ANSWER_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

export interface PreparedContext {
  readonly source: string;
  readonly injectedTools?: ReadonlyArray<string> | undefined;
  readonly instructionSources?: ReadonlyArray<string> | undefined;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly text: string }>;
  readonly sizedEntries?:
    | ReadonlyArray<{ readonly key: string; readonly label: string; readonly bytes: number }>
    | undefined;
}

/** Extracts thread child preambles for instruction-size accounting. */
export function childPreambleEntries(text: string): PreparedContext["entries"] {
  const entries: PreparedContext["entries"][number][] = [];
  const closingTag = "</child_preamble>";
  let cursor = 0;
  while (cursor < text.length) {
    const opening = text.indexOf("<child_preamble", cursor);
    if (opening < 0) break;
    const contentStart = text.indexOf(">", opening + "<child_preamble".length);
    if (contentStart < 0) break;
    const closing = text.indexOf(closingTag, contentStart + 1);
    if (closing < 0) break;
    entries.push({
      key: "workspace_child_preamble",
      text: text.slice(contentStart + 1, closing),
    });
    cursor = closing + closingTag.length;
  }
  return entries;
}

interface RecordInput extends PreparedContext {
  readonly threadId: InstructionFootprint["threadId"];
  readonly runId: InstructionFootprint["runId"];
  readonly providerInstanceId: InstructionFootprint["providerInstanceId"];
  readonly driver: string;
  readonly model: string;
  readonly providerTurnOrdinal: number;
  readonly attemptId: string;
}
export class InstructionFootprints extends Context.Service<
  InstructionFootprints,
  {
    readonly record: (input: RecordInput) => Effect.Effect<void, ThreadInsightsError>;
    readonly list: (
      threadId: ThreadId,
      runId: RunId | null,
    ) => Effect.Effect<ReadonlyArray<InstructionFootprint>, ThreadInsightsError>;
  }
>()("t3/threadInsights/InstructionFootprints") {}

const sectionLabel = (text: string) =>
  text.includes("`list_read`")
    ? "Thread list and artifacts"
    : text.includes("### Visuals and preview")
      ? "Visuals and preview"
      : text.includes("## T3 Code QA")
        ? "QA"
        : text.includes("## T3 Code orchestration")
          ? "Delegation"
          : "Threads and environments";
const knownParts = [
  ...T3_CODE_ORCHESTRATION_SECTIONS.map((text) => ({
    key: `t3:${sectionLabel(text).toLowerCase().replaceAll(" ", "-")}`,
    label: sectionLabel(text),
    text,
  })),
  { key: "t3:browser", label: "Browser tools", text: T3_CODE_BROWSER_TOOL_INSTRUCTIONS },
  {
    key: "t3:devices",
    label: "Device tools",
    text: T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  },
  { key: "t3:devices", label: "Device tools", text: T3_CODE_DEVICE_TOOL_INSTRUCTIONS },
  { key: "t3:questions", label: "Thread questions", text: T3_CODE_QUESTION_TOOL_INSTRUCTIONS },
  {
    key: "t3:tracked-answers",
    label: "Tracked answers",
    text: T3_CODE_TRACKED_ANSWER_INSTRUCTIONS,
  },
  {
    key: "t3:pull-requests",
    label: "Pull request links and watches",
    text: PULL_REQUEST_LINKING_INSTRUCTIONS,
  },
].toSorted((left, right) => right.text.length - left.text.length);

export interface PreparedContextPart extends InstructionFootprintPart {
  readonly text: string;
}

/** Splits adapter-supplied payload into labelled parts, without estimating hidden harness instructions. */
export function splitPreparedContext(
  entries: PreparedContext["entries"],
): ReadonlyArray<PreparedContextPart> {
  const parts: {
    key: string;
    label: string;
    category: PreparedContextPart["category"];
    text: string;
  }[] = [];
  const add = (
    key: string,
    label: string,
    category: InstructionFootprintPart["category"],
    text: string,
  ) => {
    if (!text.length) return;
    const separator = category === "t3" && text.trim() === "";
    parts.push(
      separator
        ? { key: "t3:separators", label: "Prompt separators", category, text }
        : { key, label, category, text },
    );
  };
  for (const entry of entries) {
    // A notice repeats sections the session lacked; it is its own cost, not those sections'.
    if (entry.key === "t3_update_notice") {
      add("t3:update-notice", "Instruction update notice", "t3", entry.text);
      continue;
    }
    const category = entry.key.startsWith("t3_code_")
      ? "t3"
      : entry.key.startsWith("custom_")
        ? "custom"
        : "app-context";
    if (category !== "t3") {
      add(
        entry.key,
        category === "custom" ? "Custom prompt append" : entry.key,
        category,
        entry.text,
      );
      continue;
    }
    const ranges: { start: number; end: number; key: string; label: string }[] = [];
    for (const part of knownParts) {
      const start = entry.text.indexOf(part.text);
      const end = start + part.text.length;
      if (start >= 0 && !ranges.some((range) => start < range.end && end > range.start))
        ranges.push({ start, end, key: part.key, label: part.label });
    }
    const runtime = /<runtime_info>[\s\S]*?<\/runtime_info>/.exec(entry.text);
    if (
      runtime &&
      !ranges.some(
        (range) => runtime.index < range.end && runtime.index + runtime[0].length > range.start,
      )
    )
      ranges.push({
        start: runtime.index,
        end: runtime.index + runtime[0].length,
        key: "t3:runtime",
        label: "Runtime identity and output",
      });
    ranges.sort((left, right) => left.start - right.start);
    let cursor = 0;
    const label = entry.key.includes("background")
      ? "Background wait"
      : entry.key.includes("separator")
        ? "Prompt separators"
        : entry.key === "t3_code_prompt"
          ? "Prompt wrapper and mode notes"
          : entry.key;
    for (const range of ranges) {
      add(entry.key, label, category, entry.text.slice(cursor, range.start));
      add(range.key, range.label, category, entry.text.slice(range.start, range.end));
      cursor = range.end;
    }
    add(entry.key, label, category, entry.text.slice(cursor));
  }
  const grouped = new Map<string, PreparedContextPart>();
  for (const part of parts) {
    const identity = `${part.category}:${part.key}:${part.label}`;
    const text = (grouped.get(identity)?.text ?? "") + part.text;
    const bytes = Buffer.byteLength(text, "utf8");
    grouped.set(identity, { ...part, text, bytes, estimatedTokens: Math.ceil(bytes / 4) });
  }
  return [...grouped.values()];
}

const measurePreparedContext = (
  context: Pick<PreparedContext, "entries" | "sizedEntries">,
): ReadonlyArray<InstructionFootprintPart> => [
  ...splitPreparedContext(context.entries).map(({ text: _text, ...part }) => part),
  ...(context.sizedEntries ?? []).map((entry) => ({
    key: entry.key,
    label: entry.label,
    category: "t3" as const,
    bytes: entry.bytes,
    estimatedTokens: Math.ceil(entry.bytes / 4),
  })),
];

const Persisted = Schema.Struct({
  formatVersion: Schema.Literal(1),
  footprint: InstructionFootprint,
});
const decode = Schema.decodeEffect(Schema.fromJsonString(Persisted));
const encode = Schema.encodeEffect(Schema.fromJsonString(Persisted));
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const directory = (threadId: ThreadId) =>
    path.join(config.stateDir, "instruction-footprints", digest(threadId));
  return InstructionFootprints.of({
    record: Effect.fn("InstructionFootprints.record")(function* (input) {
      const footprint: InstructionFootprint = {
        threadId: input.threadId,
        runId: input.runId,
        providerInstanceId: input.providerInstanceId,
        driver: input.driver,
        model: input.model,
        source: input.source,
        providerTurnOrdinal: input.providerTurnOrdinal,
        attemptId: input.attemptId,
        capturedAt: DateTime.formatIso(yield* DateTime.now),
        parts: measurePreparedContext(input),
        truncated:
          (input.injectedTools?.length ?? 0) > 256 || (input.instructionSources?.length ?? 0) > 64,
        ...(input.injectedTools === undefined
          ? {}
          : {
              injectedTools: input.injectedTools.slice(0, 256).map((name) => name.slice(0, 256)),
              injectedToolCount: input.injectedTools.length,
            }),
        ...(input.instructionSources === undefined
          ? {}
          : {
              instructionSources: yield* Effect.forEach(
                input.instructionSources.slice(0, 64),
                (source) =>
                  fs.stat(source).pipe(
                    Effect.map((stat) => ({
                      path: source.slice(0, 512),
                      bytes: Number(stat.size),
                    })),
                    Effect.orElseSucceed(() => ({ path: source.slice(0, 512), bytes: null })),
                  ),
              ),
            }),
      };
      const contents = yield* encode({ formatVersion: 1, footprint }).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadInsightsError({ message: "Could not encode instruction sizes.", cause }),
        ),
      );
      yield* writeFileStringAtomically({
        filePath: path.join(
          directory(input.threadId),
          `${digest(input.runId)}-${input.providerTurnOrdinal}-${digest(input.attemptId)}.json`,
        ),
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ThreadInsightsError({ message: "Could not save instruction sizes.", cause }),
        ),
      );
    }),
    list: Effect.fn("InstructionFootprints.list")(function* (threadId, runId) {
      const files = yield* fs.readDirectory(directory(threadId)).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed([]),
        ),
        Effect.mapError(
          (cause) =>
            new ThreadInsightsError({ message: "Could not list instruction sizes.", cause }),
        ),
      );
      const footprints: InstructionFootprint[] = [];
      const runPrefix = runId === null ? null : `${digest(runId)}-`;
      for (const name of files.filter(
        (name) =>
          /^[a-f0-9]{64}-\d+-[a-f0-9]{64}\.json$/.test(name) &&
          (runPrefix === null || name.startsWith(runPrefix)),
      )) {
        const contents = yield* fs
          .readFileString(path.join(directory(threadId), name))
          .pipe(
            Effect.mapError(
              (cause) =>
                new ThreadInsightsError({ message: "Could not read instruction sizes.", cause }),
            ),
          );
        const { footprint } = yield* decode(contents).pipe(
          Effect.mapError(
            (cause) =>
              new ThreadInsightsError({ message: "Saved instruction sizes are malformed.", cause }),
          ),
        );
        if (footprint.threadId !== threadId)
          return yield* new ThreadInsightsError({
            message: "Saved instruction sizes belong to another thread.",
          });
        if (runId === null || footprint.runId === runId) footprints.push(footprint);
      }
      return footprints.toSorted((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    }),
  });
});
export const layer = Layer.effect(InstructionFootprints, make);
