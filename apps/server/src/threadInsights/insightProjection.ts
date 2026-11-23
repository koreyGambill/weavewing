import type {
  LoadWatcher,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  ThreadLoadEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const commandWords = (command: string) => command.split(/[\s;&|()]+/).filter(Boolean);

/** The watcher's words as consecutive words of the command; the first may carry a path. */
function commandMatches(words: ReadonlyArray<string>, match: string) {
  const wanted = match.trim().split(/\s+/);
  for (let start = 0; start + wanted.length <= words.length; start++) {
    const first = words[start]!.slice(words[start]!.lastIndexOf("/") + 1);
    if (first === wanted[0] && wanted.every((word, at) => at === 0 || words[start + at] === word))
      return true;
  }
  return false;
}

/** `*` matches any run of characters; each literal part is found once, left to right. */
function toolMatches(name: string, glob: string) {
  const parts = glob.split("*");
  const first = parts[0]!;
  const last = parts.at(-1)!;
  if (parts.length === 1) return name === glob;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  let at = first.length;
  const end = name.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return at <= end;
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const instructionPath =
  /(?:^|[/\\])(?:AGENTS\.md|CLAUDE\.md|MEMORY\.md|LOCAL\.md|[^/\\]*instructions?[^/\\]*\.(?:md|txt))$/i;
const skillPath = /(?:^|[/\\])SKILL\.md$/i;
const pathKeys = new Set([
  "path",
  "file_path",
  "filePath",
  "filename",
  "fileName",
  "uri",
  "resource",
  "main_resource",
]);

function inputPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  return Object.entries(input).flatMap(([key, value]) => {
    if (pathKeys.has(key) && typeof value === "string") return [value];
    if ((key === "paths" || key === "files") && Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
    return [];
  });
}

function outputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return null;
  // Provider tool results are JSON values; count their rendered payload without retaining it.
  try {
    return JSON.stringify(output);
  } catch {
    return null;
  }
}

function shellCommand(input: string): string {
  // Codex reports the shell invocation, including shell-word quoting, rather than just its script.
  const wrapped = input.match(/^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/);
  if (!wrapped) return input;
  const script = wrapped[2] ?? "";
  return wrapped[1] === "'"
    ? script.replaceAll("'\\''", "'")
    : script.replace(/\\(["\\$`])/g, "$1");
}

function shellReads(command: string): { paths: string[]; search: boolean } {
  // Infer only literal operands of read commands; shell expansion needs provider telemetry.
  const tokens =
    command.match(
      /\d*[<>]+|(?:[^\s'"\\;&|<>]|\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*")+|&&|\|\||[;&|]+|\n/g,
    ) ?? [];
  const paths: string[] = [];
  let search = false;
  let words: string[] = [];
  const collect = () => {
    const executable = words.shift()?.split("/").at(-1);
    if (!executable || !/^(?:cat|sed|head|tail|rg|grep|less|more)$/.test(executable)) return;
    if (executable === "sed" && words.some((word) => /^-(?:[^-]*i|-in-place)/.test(word))) return;
    const searching = executable === "rg" || executable === "grep";
    search ||= searching;
    let expression = executable === "sed" || searching;
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!;
      if (
        /^(?:-[ef]|--(?:regexp|file|expression))$/.test(word) ||
        (/^(?:head|tail)$/.test(executable) && /^(?:-[nc]|--(?:lines|bytes))$/.test(word)) ||
        (searching &&
          /^(?:-[mABCD]|--(?:max-count|after-context|before-context|context))$/.test(word))
      ) {
        if (/^(?:-[ef]|--(?:regexp|expression))$/.test(word)) expression = false;
        index++;
      } else if (word.startsWith("-")) {
        if (/^(?:-[ef].+|--(?:regexp|expression)=)/.test(word)) expression = false;
      } else if (expression) expression = false;
      else if (!/[\u0000$`*?{}]/.test(word) && word !== "-" && !word.endsWith("/"))
        paths.push(word);
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (/^[;&|\n]+$/.test(token)) {
      collect();
      words = [];
    } else if (/^\d*[<>]+$/.test(token)) {
      index++;
    } else {
      words.push(
        token.replace(
          /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])/g,
          (
            _match,
            single: string | undefined,
            double: string | undefined,
            escaped: string | undefined,
          ) => single ?? double?.replace(/\\(["\\$`])/g, "$1") ?? escaped ?? "",
        ),
      );
    }
  }
  collect();
  return { paths, search };
}

export function projectLoadEvent(
  item: OrchestrationV2TurnItem | OrchestrationV2TurnItemJson,
  watchers: ReadonlyArray<LoadWatcher>,
): ThreadLoadEvent | null {
  let paths: string[] = [];
  let toolName: string;
  let kind: ThreadLoadEvent["kind"] = "file";
  let evidence: ThreadLoadEvent["evidence"] = "reported";
  let output: string | null = null;
  let label: string | undefined;
  if (item.type === "file_search") {
    toolName = "file_search";
    kind = "search";
    paths = item.results?.map((entry) => entry.fileName) ?? [];
  } else if (item.type === "dynamic_tool") {
    toolName = item.toolName ?? "tool";
    const watcher = watchers.find(
      (entry) => entry.kind === "tool" && toolMatches(toolName, entry.match),
    );
    if (watcher) {
      kind = "knowledge";
      label = `${watcher.label}: ${toolName}`;
    } else if (
      /^Skill$/i.test(toolName) ||
      /skill.*(?:read|load)|(?:read|load).*skill/i.test(toolName)
    ) {
      kind = "skill";
      if (
        typeof item.input === "object" &&
        item.input !== null &&
        "skill" in item.input &&
        typeof item.input.skill === "string"
      )
        label = item.input.skill;
    } else if (
      /read.*resource|resource.*read|t3_(?:thread_read|context_read)|list_read|artifact_read|skills[._/].*read/i.test(
        toolName,
      )
    ) {
      kind = "resource";
      label = toolName;
      if (/t3_(?:thread_read|context_read)|list_read|artifact_read/.test(toolName)) {
        const target =
          typeof item.input === "object" &&
          item.input !== null &&
          "threadId" in item.input &&
          typeof item.input.threadId === "string"
            ? item.input.threadId
            : item.threadId;
        label = `${toolName} ${target}`;
      }
    } else if (/search|glob|grep/i.test(toolName)) kind = "search";
    else if (
      !/(?:^|[._/])(?:read|read_file|readfile|read_text_file|open_file|view_image)(?:$|[._/])/i.test(
        toolName,
      )
    )
      return null;
    paths = inputPaths(item.input);
    output = item.outputOmitted ? null : outputText(item.output);
  } else if (item.type === "command_execution") {
    const command = shellCommand(item.input);
    const words = commandWords(command);
    const watcher = watchers.find(
      (entry) => entry.kind === "command" && commandMatches(words, entry.match),
    );
    const reads = shellReads(command);
    if (!watcher && !reads.paths.length) return null;
    evidence = "inferred";
    toolName = "shell";
    kind = watcher ? "knowledge" : reads.search ? "search" : "file";
    if (watcher) label = `${watcher.label}: ${command}`.slice(0, 512);
    paths = watcher ? [] : reads.paths;
    output = item.outputOmitted ? null : (item.output ?? null);
  } else return null;
  paths = [...new Set(paths)].slice(0, 64).map((path) => path.slice(0, 512));
  if (kind !== "search" && kind !== "knowledge") {
    if (paths.some((path) => skillPath.test(path))) kind = "skill";
    else if (paths.some((path) => instructionPath.test(path))) kind = "instructions";
  }
  const outputBytes = output === null ? null : bytes(output);
  return {
    itemId: item.id,
    runId: item.runId,
    at:
      typeof (item.startedAt ?? item.updatedAt) === "string"
        ? String(item.startedAt ?? item.updatedAt)
        : DateTime.formatIso(DateTime.makeUnsafe(item.startedAt ?? item.updatedAt)),
    kind,
    label:
      label ??
      paths[0] ??
      (kind === "search" ? "File search" : kind === "skill" ? "Skill read" : "Resource read"),
    paths,
    toolName,
    evidence,
    status:
      item.type === "command_execution" && item.exitCode != null && item.exitCode !== 0
        ? "failed"
        : item.status,
    outputBytes,
    estimatedOutputTokens: outputBytes === null ? null : Math.ceil(outputBytes / 4),
  };
}
