#!/usr/bin/env node
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { buildMessageSummaryPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeClaudeTextGeneration } from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-haiku-5-5" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    "dry-run": { type: "boolean", default: false },
  },
});
const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;
const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: values.model };
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

await Effect.runPromise(
  Effect.gen(function* () {
    if (values["dry-run"]) {
      for (const entry of selected)
        process.stdout.write(
          `${encode({ case: entry.id, ...buildMessageSummaryPrompt(entry), outputSchema: undefined })}\n`,
        );
      return;
    }
    if (!values.out)
      throw new Error("Use --out <directory> [--model <claude model>] or --dry-run.");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-message-summaries-" });
    const generation = yield* makeClaudeTextGeneration(yield* decodeClaudeSettings({}));
    const summarize = generation.generateMessageSummary;
    if (!summarize) throw new Error("The Claude text generator cannot summarize messages.");
    const rows = [];
    for (const entry of selected)
      for (let sample = 0; sample < Number(values.samples); sample++) {
        const row = yield* summarize({ cwd, modelSelection, ...entry }).pipe(
          Effect.map(({ summary }) => ({ summary, ...grade(entry, summary) })),
          Effect.catch((error) => Effect.succeed({ pass: false, reason: String(error) })),
        );
        rows.push({ case: entry.id, sample, ...row });
      }
    yield* fs.makeDirectory(values.out, { recursive: true });
    yield* fs.writeFileString(
      path.join(values.out, "results.ndjson"),
      rows.map((row) => encode(row)).join("\n") + "\n",
    );
    const lines = ["| case | pass | summaries |", "|---|---|---|"];
    for (const entry of selected) {
      const own = rows.filter((row) => row.case === entry.id);
      lines.push(
        `| ${entry.id} | ${own.filter((row) => row.pass).length}/${own.length} | ${own.map((row) => ("summary" in row ? row.summary : row.reason)).join(" / ")} |`,
      );
    }
    lines.push("", `model ${values.model}`);
    yield* fs.writeFileString(path.join(values.out, "summary.md"), lines.join("\n") + "\n");
    process.stdout.write(lines.join("\n") + "\n");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
