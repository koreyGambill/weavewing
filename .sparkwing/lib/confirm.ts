import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { failingTestFiles } from "./suites.ts";

/** Text safe inside a Markdown table cell. */
export function markdownCell(text: string): string {
  return text.replace(/[\\|`]/g, "\\$&").replace(/\s+/g, " ");
}

/** Appends to an absolute report file, refusing to follow a symlink there. */
export function appendReport(file: string, text: string): void {
  if (!NodePath.isAbsolute(file)) throw new Error(`The report path must be absolute, got "${file}"`);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const { O_APPEND, O_CREAT, O_NOFOLLOW, O_WRONLY } = NodeFS.constants;
  const fd = NodeFS.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o644);
  try {
    NodeFS.writeSync(fd, text);
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * Appends a dated section naming the failing test files in a failed child's logs, and returns
 * whether it did. Only a child whose suites all ran, with at least one failing, has a finding:
 * its results.json names the commit it tested, which may be newer than the one fetched. A child
 * that could not plan, was stopped part way, or had a suite crash before testing adds none.
 */
export function reportFailure(file: string, branch: string, runId: string, logs: string): boolean {
  const finished = NodePath.join(logs, "results.json");
  if (!NodeFS.existsSync(finished)) return false;
  const record = JSON.parse(NodeFS.readFileSync(finished, "utf8"));
  // A suite that crashed before its tests ran is "not-run": that says nothing about main either.
  const results = Object.values(record.results ?? {});
  if (results.includes("not-run") || !results.includes("failed")) return false;
  const commit = String(record.commit ?? "");
  const rows = failingTestFiles(logs).map(({ log, file: path }) => `| ${markdownCell(log)} | ${markdownCell(path)} |`);
  const body =
    rows.length > 0
      ? `| Log | File |\n| --- | --- |\n${rows.join("\n")}\n`
      : `No failing test file appears in the suite logs; read them in \`${logs}\`.\n`;
  appendReport(
    file,
    `\n## ${new Date().toISOString()}: daily confirmation of ${branch} ${commit.slice(0, 10)}\n\n` +
      `Run \`${runId}\` failed. Logs: \`${logs}\`.\n\n${body}`,
  );
  return true;
}
