#!/usr/bin/env node
// Eval-only plumbing around the local `claude -p` login.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { ComposerContextId, type ReviewCommentContextRecord } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import { cases, type Case } from "./cases.ts";
import { grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-haiku-5-5" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    task: { type: "string", default: "sed" },
    "dry-run": { type: "boolean", default: false },
  },
});

const TASKS: Record<string, string> = {
  sed: "You are a coding agent without file access in this turn. Reply with only the one shell command that applies the user's request, as `sed -i` with a numeric line address. No prose.",
  cite: 'You are a coding agent. Before editing, record which lines the user\'s comment targets. Reply with only JSON: {"file": string, "startLine": number, "endLine": number}.',
};
const TASK = TASKS[values.task];
if (!TASK) throw new Error(`--task must be one of ${Object.keys(TASKS).join(", ")}`);

export function buildPrompt(entry: Case): string {
  const contextId = ComposerContextId.make(`review-comment_${entry.id}`);
  const record: ReviewCommentContextRecord = {
    version: 1,
    contextId,
    kind: "review-comment",
    label: `${entry.filePath} ${entry.rangeLabel}`,
    sectionId: `file:${entry.filePath}`,
    sectionTitle: entry.sectionTitle,
    filePath: entry.filePath,
    startIndex: entry.startIndex,
    endIndex: entry.endIndex,
    rangeLabel: entry.rangeLabel,
    text: entry.comment,
    diff: entry.snippet,
    fenceLanguage: entry.fenceLanguage,
  };
  const reference = formatComposerContextReference({
    kind: "review-comment",
    contextId,
    label: record.label,
  });
  return projectComposerContextForProvider({ text: `${reference} `, records: [record] });
}

const ask = (model: string, prompt: string, cwd: string) =>
  new Promise<{ result: string; costUsd: number | undefined }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "claude",
      [
        "-p",
        "--model",
        model,
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--system-prompt",
        TASK,
      ],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr || stdout}`));
      const parsed = JSON.parse(stdout) as { result?: string; total_cost_usd?: number };
      resolve({ result: parsed.result ?? "", costUsd: parsed.total_cost_usd });
    });
    child.stdin.end(prompt);
  });

const selected = values.case ? cases.filter((entry) => values.case!.includes(entry.id)) : cases;

if (values["dry-run"]) {
  for (const entry of selected) process.stdout.write(`--- ${entry.id}\n${buildPrompt(entry)}\n`);
} else {
  if (!values.out) throw new Error("Use --out <directory> [--model <claude model>] or --dry-run.");
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-context-line-refs-"));
  const jobs = selected.flatMap((entry) =>
    Array.from({ length: Number(values.samples) }, (_, sample) => ({ entry, sample })),
  );
  const rows = await Promise.all(
    jobs.map(async ({ entry, sample }) => {
      try {
        const { result, costUsd } = await ask(values.model, buildPrompt(entry), cwd);
        return {
          case: entry.id,
          sample,
          output: result.trim(),
          costUsd,
          ...grade(entry, result, values.task),
        };
      } catch (error) {
        return { case: entry.id, sample, output: "", pass: false, reason: String(error) };
      }
    }),
  );
  await NodeFSP.rm(cwd, { recursive: true, force: true });
  await NodeFSP.mkdir(values.out, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(values.out, "results.ndjson"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const lines = [
    `model ${values.model}, task ${values.task}`,
    "",
    "| case | pass | outputs |",
    "|---|---|---|",
    ...selected.map((entry) => {
      const own = rows.filter((row) => row.case === entry.id);
      const outputs = own.map((row) => `\`${row.output || row.reason}\``.replaceAll("|", "\\|"));
      return `| ${entry.id} | ${own.filter((row) => row.pass).length}/${own.length} | ${outputs.join(" / ")} |`;
    }),
  ];
  const costs = rows.flatMap((row) => ("costUsd" in row && row.costUsd ? [row.costUsd] : []));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  lines.push(
    "",
    `${rows.filter((row) => row.pass).length}/${rows.length} pass, total $${total.toFixed(4)}`,
  );
  await NodeFSP.writeFile(NodePath.join(values.out, "summary.md"), lines.join("\n") + "\n");
  process.stdout.write(lines.join("\n") + "\n");
}
