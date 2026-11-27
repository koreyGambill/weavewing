import {
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  LIST_FILED_TASKS_LIMIT,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import {
  HTML_RENDER_TOOL_NAME,
  readHtmlRenderReference,
  type HtmlRenderReference,
} from "./htmlRender.ts";
import {
  claudeMcpToolName,
  MCP_APP_OUTPUT_KEY,
  readMcpAppReference,
  type McpAppReference,
} from "./mcpApp.ts";
import { resolveT3McpToolId, resolveT3McpMessageTool } from "./t3McpToolPresentation.ts";

export const SEND_TO_USER_TOOL_NAME = "send_to_user";
// 4,000 UTF-16 units stay inside MAX_PARSED_BYTES even as 3-byte characters.
export const SEND_TO_USER_MAX_LENGTH = 4_000;

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_ID_LENGTH = 256;
const MAX_THREADS = 100;
const QUESTION_ASK_TOOL_NAME = "question_ask";
const TRACKED_ANSWER_TOOL = /^(?:(?:mcp__)?t3[-_]?code(?:[-_]direct)?(?:__|[.:/_]))?answer_give$/i;
// Review tools have no presentation entry, so the T3 server prefix is matched here.
const EVIDENCE_RECORD_TOOL =
  /^(?:(?:mcp__)?t3[-_]?code(?:[-_]direct)?(?:__|[.:/_]))?evidence_record$/i;
const LIST_WRITE_TOOL =
  /^(?:(?:mcp__)?t3[-_]?code(?:[-_]direct)?(?:__|[.:/_]))?list_(?:update|rewrite)$/i;
const EVIDENCE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MAX_CONTENT_BLOCKS = 32;
const MAX_ENVELOPE_DEPTH = 4;
const MAX_ENVELOPE_NODES = 128;
const encoder = new TextEncoder();

interface ResultReadBudget {
  remainingBytes: number;
  remainingNodes: number;
  exceeded: boolean;
}

interface ResultEnvelope {
  data?: Record<PropertyKey, unknown>;
  failed: boolean;
}

interface CompactToolOutput {
  isError?: true;
  threadId?: string;
  messageId?: string;
  replyToMessageId?: string;
  taskId?: string;
  scheduledTaskId?: string;
  status?: "rolled_back";
  htmlRender?: HtmlRenderReference;
  [MCP_APP_OUTPUT_KEY]?: McpAppReference;
  thread?: { threadId: string };
  threads?: Array<{ threadId?: string; status?: "rolled_back" }>;
  linkedCount?: number;
  unlinkedCount?: number;
  childThreadId?: string;
  remoteChild?: { threadId: string; environmentId: string };
  link?: string;
  delivery?: "started" | "queued" | "steered" | "restarted";
  reply?: boolean;
  error?: string;
  sentMessage?: string;
  /** The ids `question_ask` assigned, so clients place each question's card at the call. */
  questionIds?: string[];
  trackedAnswer?: { id: string; n: number };
  /** The landing `evidence_record` stored, so clients place its QA cards at the call. */
  landingId?: string;
  /** The user tasks a `list_update` or `list_rewrite` call filed, so clients place their cards. */
  filedTasks?: string[];
}

function readResult(value: unknown, budget: ResultReadBudget, depth = 0): ResultEnvelope {
  if (depth > MAX_ENVELOPE_DEPTH || budget.remainingNodes-- <= 0) {
    budget.exceeded = true;
    return { failed: false };
  }
  if (typeof value === "string") {
    if (value.length > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    const bytes = encoder.encode(value).byteLength;
    if (bytes > budget.remainingBytes) {
      budget.exceeded = true;
      return { failed: false };
    }
    budget.remainingBytes -= bytes;
    try {
      return readResult(JSON.parse(value), budget, depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) {
      budget.exceeded = true;
      return { failed: false };
    }
    let data: ResultEnvelope["data"];
    let failed = false;
    for (const block of value) {
      const text = Predicate.isObject(block) ? block.text : undefined;
      const result = readResult(
        Predicate.isObject(text) ? (text.text ?? text) : text,
        budget,
        depth + 1,
      );
      data ??= result.data;
      failed ||= result.failed;
      if (budget.exceeded) break;
    }
    return { ...(data === undefined ? {} : { data }), failed };
  }
  if (!Predicate.isObject(value)) return { failed: false };
  const failed =
    value.isError === true ||
    value.is_error === true ||
    value._tag === "OrchestratorMcpFailure" ||
    value.error != null;
  const content = value.structuredContent ?? value.content;
  if (content !== undefined) {
    const nested = readResult(content, budget, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data: value, failed };
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || value.trim() === "") {
    return undefined;
  }
  return Array.from(value).join("");
}

/** Bounded error text for a failed tool result, including provider content envelopes. */
export function toolResultErrorText(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_ENVELOPE_DEPTH + 1) return undefined;
  if (typeof value === "string") {
    if (value.length <= MAX_PARSED_BYTES) {
      try {
        return toolResultErrorText(JSON.parse(value), depth + 1);
      } catch {
        return value.trim() ? value.slice(0, 2048) : undefined;
      }
    }
    return value.trim() ? value.slice(0, 2048) : undefined;
  }
  if (Array.isArray(value)) {
    return (
      value
        .slice(0, MAX_CONTENT_BLOCKS)
        .map((block) => toolResultErrorText(block, depth + 1))
        .filter(Boolean)
        .join("\n")
        .slice(0, 2048) || undefined
    );
  }
  if (!Predicate.isObject(value)) return undefined;
  return (
    toolResultErrorText(value.message, depth + 1) ??
    toolResultErrorText(value.error, depth + 1) ??
    toolResultErrorText(value.structuredContent, depth + 1) ??
    toolResultErrorText(value.content ?? value.text, depth + 1)
  );
}

/** Keeps a readable outgoing preview when the full tool input exceeds the timeline budget. */
export function compactT3MessageInput(toolName: string | null, value: unknown) {
  const tool = resolveT3McpMessageTool(toolName);
  if (!tool) return undefined;
  let input = value;
  if (typeof input === "string" && input.length <= 256 * 1024) {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (!Predicate.isObject(input)) return undefined;
  if (typeof input.toolName === "string") input = input.args;
  if (!Predicate.isObject(input)) return undefined;
  const key = tool === "delegate_task" ? "task" : "message";
  const body = input[key];
  if (typeof body !== "string" || !body.trim()) return undefined;
  const target = Predicate.isObject(input.target) ? input.target : undefined;
  const origin = Predicate.isObject(input.origin) ? input.origin : undefined;
  return {
    [key]:
      body.length > 1024
        ? `${body.slice(0, 1024)}\n… Open tool details for the full message.`
        : body,
    threadId: boundedId(input.threadId),
    environmentId: boundedId(input.environmentId),
    target: { environmentId: boundedId(target?.environmentId) },
    reply: typeof input.reply === "boolean" ? input.reply : undefined,
    replyTo:
      tool === "t3_thread_send" &&
      typeof input.replyTo === "number" &&
      Number.isSafeInteger(input.replyTo) &&
      input.replyTo > 0
        ? input.replyTo
        : undefined,
    origin: {
      event: origin?.event === "reply" ? "reply" : undefined,
      reply: origin?.reply === "not expected" ? "not expected" : undefined,
    },
  };
}

export function compactDynamicToolOutput(
  value: unknown,
  toolName?: string | null,
  failed = false,
): CompactToolOutput | undefined {
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(value, budget);
  const output: CompactToolOutput = result.failed ? { isError: true } : {};
  const data = budget.exceeded ? undefined : result.data;
  if (resolveT3McpMessageTool(toolName)) {
    if (result.failed || failed) {
      output.isError = true;
      const error = toolResultErrorText(value);
      if (error !== undefined) output.error = error;
    }
    const childThreadId = boundedId(data?.childThreadId);
    if (childThreadId) output.childThreadId = childThreadId;
    const remote = data?.remoteChild;
    if (Predicate.isObject(remote)) {
      const threadId = boundedId(remote.threadId);
      const environmentId = boundedId(remote.environmentId);
      if (threadId && environmentId) output.remoteChild = { threadId, environmentId };
    }
    if (typeof data?.link === "string" && data.link.length <= 2048) output.link = data.link;
    if (typeof data?.reply === "boolean") output.reply = data.reply;
    const delivery = data?.delivery;
    if (
      delivery === "started" ||
      delivery === "queued" ||
      delivery === "steered" ||
      delivery === "restarted"
    )
      output.delivery = delivery;
  }
  if (data !== undefined) {
    for (const key of [
      "threadId",
      "messageId",
      "replyToMessageId",
      "taskId",
      "scheduledTaskId",
    ] as const) {
      const id = boundedId(data[key]);
      if (id !== undefined) output[key] = id;
    }
    if (data.status === "rolled_back") output.status = "rolled_back";
    for (const key of ["linkedCount", "unlinkedCount"] as const) {
      const count = data[key];
      if (typeof count === "number" && Number.isSafeInteger(count)) output[key] = count;
    }
    if (
      typeof data.sentMessage === "string" &&
      data.sentMessage.trim() !== "" &&
      data.sentMessage.length <= SEND_TO_USER_MAX_LENGTH
    ) {
      output.sentMessage = data.sentMessage;
    }
    const questionIds =
      data.questionIds ??
      (resolveT3McpToolId(toolName) === QUESTION_ASK_TOOL_NAME ? data.ids : undefined);
    if (
      Array.isArray(questionIds) &&
      questionIds.length > 0 &&
      questionIds.length <= MAX_THREADS &&
      questionIds.every((id) => typeof id === "string" && /^Q\d{1,9}$/.test(id))
    ) {
      output.questionIds = questionIds;
    }
    if (toolName != null && TRACKED_ANSWER_TOOL.test(toolName)) {
      const ref = Predicate.isObject(data.trackedAnswer)
        ? data.trackedAnswer
        : { id: data.id, n: data.answer };
      if (
        typeof ref.id === "string" &&
        /^A[1-9]\d{0,30}$/.test(ref.id) &&
        typeof ref.n === "number" &&
        Number.isSafeInteger(ref.n) &&
        ref.n > 0
      )
        output.trackedAnswer = { id: ref.id, n: ref.n };
    }
    // The list write files at most this many; an older or larger result keeps its first cards.
    const filedTasks = Array.isArray(data.filedTasks)
      ? data.filedTasks
          .filter((ref): ref is string => typeof ref === "string" && /^T\d{1,9}$/.test(ref))
          .slice(0, LIST_FILED_TASKS_LIMIT)
      : [];
    if (toolName != null && LIST_WRITE_TOOL.test(toolName) && filedTasks.length > 0)
      output.filedTasks = filedTasks;
    if (
      toolName != null &&
      EVIDENCE_RECORD_TOOL.test(toolName) &&
      typeof data.landingId === "string" &&
      EVIDENCE_SLUG.test(data.landingId)
    )
      output.landingId = data.landingId;
    const htmlRender = readHtmlRenderReference(data.htmlRender);
    if (htmlRender !== undefined) output.htmlRender = htmlRender;
    const mcpApp = readMcpAppReference(data[MCP_APP_OUTPUT_KEY]);
    if (mcpApp !== undefined) output[MCP_APP_OUTPUT_KEY] = mcpApp;
    const nestedThreadId = Predicate.isObject(data.thread)
      ? boundedId(data.thread.threadId)
      : undefined;
    if (nestedThreadId !== undefined) output.thread = { threadId: nestedThreadId };

    if (Array.isArray(data.threads)) {
      let complete = data.threads.length <= MAX_THREADS;
      const threads: NonNullable<CompactToolOutput["threads"]> = [];
      if (complete) {
        for (const entry of data.threads) {
          if (!Predicate.isObject(entry)) {
            complete = false;
            break;
          }
          const threadId = boundedId(entry.threadId);
          const rolledBack = entry.status === "rolled_back";
          if (threadId === undefined && !rolledBack) {
            complete = false;
            break;
          }
          threads.push({
            ...(threadId === undefined ? {} : { threadId }),
            ...(rolledBack ? { status: "rolled_back" as const } : {}),
          });
        }
      }
      if (complete) output.threads = threads;
      else {
        // Partial batches or top-level ids make the summary parser report a false creation count.
        delete output.threadId;
        delete output.status;
      }
    }
  }
  const oversized = () => encoder.encode(JSON.stringify(output)).byteLength > MAX_METADATA_BYTES;
  if (oversized()) {
    delete output.threads;
    delete output.threadId;
    delete output.status;
  }
  const app = output[MCP_APP_OUTPUT_KEY];
  if (app?.csp !== undefined && oversized()) {
    const { csp: _csp, ...rest } = app;
    output[MCP_APP_OUTPUT_KEY] = rest;
  }
  if (oversized()) delete output[MCP_APP_OUTPUT_KEY];
  if (oversized()) {
    delete output.error;
    delete output.link;
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

// OpenCode 2 Code Mode reports a script's nested T3 tool calls as one item with the script's result.
const OPENCODE_CODE_MODE_TOOL_NAME = "execute";

export function htmlRenderFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): HtmlRenderReference | undefined {
  if (
    item.toolName !== OPENCODE_CODE_MODE_TOOL_NAME &&
    resolveT3McpToolId(item.toolName) !== HTML_RENDER_TOOL_NAME
  ) {
    return undefined;
  }
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.htmlRender;
}

/** The text `send_to_user` showed the user, which clients render as the agent's own words. */
export function sentMessageFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (
    item.toolName !== OPENCODE_CODE_MODE_TOOL_NAME &&
    resolveT3McpToolId(item.toolName) !== SEND_TO_USER_TOOL_NAME
  ) {
    return undefined;
  }
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? undefined : output?.sentMessage;
}

/** The question ids a `question_ask` call created; empty when it failed or is another tool. */
export function questionIdsFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): ReadonlyArray<string> {
  if (resolveT3McpToolId(item.toolName) !== QUESTION_ASK_TOOL_NAME) return [];
  const output = compactDynamicToolOutput(item.output);
  return output?.isError ? [] : (output?.questionIds ?? []);
}

export function trackedAnswerFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly status: string;
  readonly output?: unknown;
}): { readonly id: string; readonly n: number } | undefined {
  if (
    item.status !== "completed" ||
    item.toolName == null ||
    !TRACKED_ANSWER_TOOL.test(item.toolName)
  )
    return undefined;
  const output = compactDynamicToolOutput(item.output, item.toolName);
  return output?.isError ? undefined : output?.trackedAnswer;
}

/** The user tasks a list write filed; empty when it failed, filed none or is another tool. */
export function filedTasksFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): ReadonlyArray<string> {
  if (item.toolName == null || !LIST_WRITE_TOOL.test(item.toolName)) return [];
  const output = compactDynamicToolOutput(item.output, item.toolName);
  return output?.isError ? [] : (output?.filedTasks ?? []);
}

/** The landing an `evidence_record` call stored; undefined when it failed or is another tool. */
export function evidenceLandingIdFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (item.toolName == null || !EVIDENCE_RECORD_TOOL.test(item.toolName)) return undefined;
  const output = compactDynamicToolOutput(item.output, item.toolName);
  return output?.isError ? undefined : output?.landingId;
}

/** The thread-owned file `preview_recording_stop` stored for the agent. */
export function previewRecordingIdFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): string | undefined {
  if (resolveT3McpToolId(item.toolName) !== "preview_recording_stop") return undefined;
  const budget: ResultReadBudget = {
    remainingBytes: MAX_PARSED_BYTES,
    remainingNodes: MAX_ENVELOPE_NODES,
    exceeded: false,
  };
  const result = readResult(item.output, budget);
  return result.failed || budget.exceeded ? undefined : boundedId(result.data?.id);
}

/** Accept app references only when server and tool match the item, so tools cannot impersonate another app source. */
export function mcpAppFromToolItem(item: {
  readonly toolName: string | null | undefined;
  readonly output?: unknown;
}): McpAppReference | undefined {
  const app = compactDynamicToolOutput(item.output)?.[MCP_APP_OUTPUT_KEY];
  return app !== undefined &&
    (item.toolName === `${app.server}.${app.tool}` ||
      item.toolName === claudeMcpToolName(app.server, app.tool))
    ? app
    : undefined;
}

// A superset of every needle below, so most outputs are rejected by this single scan.
const FAILURE_HINT =
  /enoent|no such|no files found|not found|commandnotfound|not recognized|cannot (?:find path|be found)|exit/i;

/** Some providers report completion even when command output describes a failure. */
export function toolOutputIndicatesFailure(text: string): boolean {
  return (
    FAILURE_HINT.test(text) &&
    (/file not found|no files found|enoent|no such file|commandnotfoundexception|command not found|is not recognized as the name of a cmdlet|a parameter cannot be found that matches parameter name/i.test(
      text,
    ) ||
      (/cannot find path/i.test(text) && /because it does not exist/i.test(text)) ||
      (/is not recognized/i.test(text) && /the term '/i.test(text)) ||
      /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
      /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text))
  );
}

export interface ToolOutputImage {
  readonly mimeType: string;
  readonly data?: string;
}

/** Raster types only, so agent SVG/HTML cannot be served inline. */
export function readToolOutputImage(block: unknown): ToolOutputImage | null {
  if (!Predicate.isObject(block) || block.type !== "image") return null;
  const source = Predicate.isObject(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return null;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  const data = source === undefined ? block.data : source.data;
  if (typeof mimeType !== "string" || !isProviderSendTurnSupportedImageMimeType(mimeType)) {
    return null;
  }
  const image = { mimeType: mimeType.toLowerCase() };
  return typeof data === "string" ? { ...image, data } : image;
}

function outputBlocks(value: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(value)) return value;
  if (Predicate.isObject(value) && Array.isArray(value.content)) return value.content;
  return [value];
}

export const MAX_TOOL_OUTPUT_IMAGES = 8;

export const MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH =
  Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4;

export function toolOutputImageBlocks(value: unknown): ReadonlyArray<unknown> {
  const blocks: unknown[] = [];
  for (const block of outputBlocks(value)) {
    if (readToolOutputImage(block) === null) continue;
    blocks.push(block);
    if (blocks.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return blocks;
}

/** Order defines the shared tool-output-image asset index. */
export function toolOutputImages(value: unknown): ReadonlyArray<ToolOutputImage> {
  return toolOutputImageBlocks(value).flatMap((block) => readToolOutputImage(block) ?? []);
}

export function mcpToolResultOutput(result: {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}): unknown {
  const structuredContent =
    (Array.isArray(result.structuredContent) || Predicate.isObject(result.structuredContent)) &&
    Object.keys(result.structuredContent).length === 0
      ? undefined
      : result.structuredContent;
  if (structuredContent != null && toolOutputImages(result.content).length > 0) {
    return { content: result.content, structuredContent };
  }
  return structuredContent ?? result.content;
}

export function omitToolOutputImageData(value: unknown): unknown {
  const omit = (block: unknown) => {
    const image = readToolOutputImage(block);
    return image?.data === undefined ? block : { type: "image", mimeType: image.mimeType };
  };
  if (Array.isArray(value)) return value.map(omit);
  if (Predicate.isObject(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(omit) };
  }
  return omit(value);
}
