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
    baseline: { type: "string" },
    from: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const TASK =
  'You are a coding agent. Before editing, record which lines the user\'s comment targets. Reply with only JSON: {"file": string, "startLine": number, "endLine": number}.';
// Saved runs name their task so a re-grade never applies this grader to another task's outputs.
const TASK_NAME = "cite";

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

interface Row {
  readonly task?: string;
  readonly case: string;
  readonly sample: number;
  readonly output: string;
  readonly costUsd?: number | undefined;
  readonly pass: boolean;
  readonly reason: string;
}

const savedTask = async (dir: string, rows: ReadonlyArray<Row>) =>
  rows[0]?.task ??
  /task (\w+)/.exec(await NodeFSP.readFile(NodePath.join(dir, "summary.md"), "utf8"))?.[1];

/** Reads a saved run of this task, limited to the selected cases. */
async function readRows(dir: string): Promise<ReadonlyArray<Row>> {
  const rows = (await NodeFSP.readFile(NodePath.join(dir, "results.ndjson"), "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row);
  const task = await savedTask(dir, rows);
  if (task !== TASK_NAME)
    throw new Error(`${dir} is a ${task ?? "unnamed"} run, not ${TASK_NAME}.`);
  const ids = new Set(selected.map((entry) => entry.id));
  return rows.filter((row) => ids.has(row.case));
}

const passCount = (rows: ReadonlyArray<Row>, id: string) => {
  const own = rows.filter((row) => row.case === id);
  return `${own.filter((row) => row.pass).length}/${own.length}`;
};

async function sampleModel(): Promise<ReadonlyArray<Row>> {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-context-line-refs-"));
  const jobs = selected.flatMap((entry) =>
    Array.from({ length: Number(values.samples) }, (_, sample) => ({ entry, sample })),
  );
  const rows = await Promise.all(
    jobs.map(async ({ entry, sample }): Promise<Row> => {
      try {
        const { result, costUsd } = await ask(values.model, buildPrompt(entry), cwd);
        return {
          task: TASK_NAME,
          case: entry.id,
          sample,
          output: result.trim(),
          costUsd,
          ...grade(entry, result),
        };
      } catch (error) {
        const reason = String(error);
        return { task: TASK_NAME, case: entry.id, sample, output: "", pass: false, reason };
      }
    }),
  );
  await NodeFSP.rm(cwd, { recursive: true, force: true });
  return rows;
}

/** Re-grades saved outputs so a grader change needs no new model calls. */
async function regrade(dir: string): Promise<ReadonlyArray<Row>> {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  return (await readRows(dir)).map((row) => {
    const entry = byId.get(row.case);
    return {
      ...row,
      task: TASK_NAME,
      ...(entry && row.output ? grade(entry, row.output) : {}),
    };
  });
}

if (values["dry-run"]) {
  for (const entry of selected) process.stdout.write(`--- ${entry.id}\n${buildPrompt(entry)}\n`);
} else {
  if (!values.out)
    throw new Error(
      "Use --out <directory> [--model <id>] [--from <earlier run>] [--baseline <earlier run>] or --dry-run.",
    );
  const rows = values.from ? await regrade(values.from) : await sampleModel();
  const baseline = values.baseline ? await readRows(values.baseline) : null;
  await NodeFSP.mkdir(values.out, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(values.out, "results.ndjson"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const lines = [
    `model ${values.from ? `(re-graded from ${values.from})` : values.model}, task ${TASK_NAME}`,
    "",
    baseline ? "| case | baseline | pass | outputs |" : "| case | pass | outputs |",
    baseline ? "|---|---|---|---|" : "|---|---|---|",
    ...selected.map((entry) => {
      const outputs = rows
        .filter((row) => row.case === entry.id)
        .map((row) => `\`${row.output || row.reason}\``.replaceAll("|", "\\|"));
      const cells = [entry.id, ...(baseline ? [passCount(baseline, entry.id)] : [])];
      return `| ${cells.join(" | ")} | ${passCount(rows, entry.id)} | ${outputs.join(" / ")} |`;
    }),
  ];
  const costs = rows.flatMap((row) => (row.costUsd ? [row.costUsd] : []));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const passed = rows.filter((row) => row.pass).length;
  const baselinePassed = baseline?.filter((row) => row.pass).length;
  lines.push(
    "",
    `${passed}/${rows.length} pass${baseline ? ` (baseline ${baselinePassed}/${baseline.length})` : ""}, total $${total.toFixed(4)}`,
  );
  await NodeFSP.writeFile(NodePath.join(values.out, "summary.md"), lines.join("\n") + "\n");
  process.stdout.write(lines.join("\n") + "\n");
}
