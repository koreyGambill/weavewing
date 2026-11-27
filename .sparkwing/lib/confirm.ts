import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
