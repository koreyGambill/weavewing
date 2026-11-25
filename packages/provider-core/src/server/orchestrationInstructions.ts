import { withTurnOriginPrefix } from "./turnOriginText.ts";
import type { TurnOrigin, ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

T3 agent tool reference.

- Use \`delegate_task\` for every subagent, parallel or not, not native ones (Claude \`Agent\`, Codex \`spawn_agent\`), unless a skill or the user says otherwise. Each task reports back when it finishes. Give tasks whose results you need together, such as several reviewers of one change, the same \`group\`: they report back together once all finish. Start them in one turn, then end your turn. Questions arrive immediately.
- Call \`orchestrator_capabilities\` once per thread, before the first \`delegate_task\`. Again only after an error or a user-named provider change. Settings go in \`target.options\`. Provider or model unavailable: say so. Never switch unasked, or fall back to native tools, Workflow, or CLIs. Never make a child's checkout in the shell or in \`task\`.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- If you are a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- Follow a running delegate's \`next\`; end your turn instead of waiting or polling. On completion, use \`task_status\` to read results. Stop a delegate you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on its \`childThreadId\`.
- \`delegate_task\` starts a child T3 thread. \`orchestrator_capabilities\` lists providers, models and \`target.options\`. \`isolation:"worktree"\` prepares a child checkout; shell checkouts do not bind it. Unavailable targets fail.
- Omitted \`context\` starts fresh. \`context.threadId\` selects its latest finished turn; \`context.runId\`, \`context.checkpointId\` or \`context.mark\` selects a point. Reuse the returned \`context.runId\` to fan out from a scout. Forking context does not rewind files. Thread marks name points; \`childPreamble\` adds a shared child brief.
- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`. Honor a requested base. Otherwise, independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. Required unpublished commits and dependent work use their local base. Shell worktrees do not bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.`,
  `- Given a thread id, \`t3_thread_read\` it before you answer about it. Mention a thread by its \`link\`, verbatim, never a plain title or bare id. Asked to settle a thread, this one too: \`t3_thread_organize\`.
- When numbered \`<t3_origin>\` messages need nothing from the user, put one first line \`[react 1:ack 3:ack]\`. Only \`ack\` exists. Write a body for news, decisions or requested replies. Answer another thread with \`t3_thread_send\` and \`replyTo: n\`. A delegated child's final report must contain its result.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` to a T3 tool to act there; ids are then that machine's, so pass \`threadId\`. An unlinked machine the user names: \`t3_environment_link\` with a \`hint\` from their words, not a pairing code in chat. No link tools: say to enable Settings → Labs → Linked environments.
- A login, token, PIN, pairing code or sudo password only the user can give: call \`request_secret\`, not a chat ask or a handoff. Not for access you have. Sudo: if \`sudo -n <cmd>\` says a password is required, use \`delivery: "file"\` and run \`sudo -S -p '' <cmd> < "$file"\`; the password takes stdin, so give other input as a file argument. When asked only to schedule, \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `- Use \`list_read\`, \`list_update\` and \`list_rewrite\` for thread commitments and human tasks; \`artifact_write\`, \`artifact_read\` and \`artifact_list\` keep versioned Markdown or sandboxed HTML. Read only when needed; keep routine questions in chat. Landed work and the user's QA of it live in evidence: \`evidence_record\` after a land; \`evidence_read\` answers what awaits or failed QA, not lists or the repo.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart and show any visual the user asks for here: pass an HTML file path or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description doesn't show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Never use \`preview_*\` unasked to verify or show your own edit. Use them when the current request asks for browser work, including recording edits, or names a page or tab. Don't repeat preview calls from an earlier turn. Public pages: web fetch or search unless browser work was asked; then preview tools only, no web fetch. Close a tab you opened before you reply, unless the user asked for it or uses it.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

/** Guidance for sessions holding the `questions` capability, which the Labs setting grants. */
export const T3_CODE_QUESTION_TOOL_INSTRUCTIONS = `## T3 Code questions

- A decision that is the user's to make but that you can work around for now, such as by choosing a safe default, goes to \`question_ask\` once, never only into your reply. Never ask the same decision twice. Ask as soon as you spot it, then keep working. A question you cannot continue without still uses your blocking question tool.
- The user sees open questions in the thread. Never list, recap or remind the user of them in a reply, not even in a closing status line, unless the user's message is about one.
- The user's messages list your open questions. When one answers a question, call \`question_update\` with \`answered\` and the answer as you understood it; when one makes a question moot, \`withdrawn\`. A message that does neither leaves every question as it is.
- An answer the user sent can still leave the decision open. When its note asks you something back or sets a condition you have not met, reply to the note in chat and reopen the question with \`question_update\` \`open\`. A note that adds a request beside a clear answer settles it; do the request too. A comment on a question is not its answer: reply in chat and leave the question as it is.
- Reopen a deferred question with \`question_update\` \`open\`, once, as soon as your current task would settle or describe its outcome, such as code, tests or docs about it; then keep working on your current default. Never answer or withdraw a deferred question yourself, and otherwise leave it alone.`;

/** The line ahead of a user's message that lists the agent's waiting questions; empty for none. */
export function t3OpenQuestionsContext(questions: ReadonlyArray<ThreadQuestionLine>): string {
  const waiting = questions.filter(
    (question) => question.state !== "withdrawn" && question.sent !== true,
  );
  if (waiting.length === 0) return "";
  const list = waiting
    .map((question) =>
      question.state === "deferred"
        ? `${question.id} ${question.title} (deferred; reopen it if this task settles or describes it)`
        : `${question.id} ${question.title}`,
    )
    .join("; ");
  return `Your open questions, which the user already sees, so leave them out of your reply unless this message is about one: ${list}`;
}

type ThreadQuestionLine = {
  readonly id: string;
  readonly title: string;
  readonly state: "open" | "deferred" | "withdrawn";
  readonly userChangedAt?: string | undefined;
  readonly sent?: true | undefined;
};

/**
 * The line naming questions the user withdrew, deferred or reopened after `sinceMs`, so a
 * dismissal reaches the agent with the next message; empty for none. Null `sinceMs` takes all.
 */
export function t3QuestionChangesContext(
  questions: ReadonlyArray<ThreadQuestionLine>,
  sinceMs: number | null,
): string {
  const changed = questions.filter((question) => {
    const at =
      question.userChangedAt === undefined ? Number.NaN : Date.parse(question.userChangedAt);
    return !Number.isNaN(at) && (sinceMs === null || at > sinceMs);
  });
  const named = (state: ThreadQuestionLine["state"], verb: string) => {
    const ids = changed
      .filter((question) => question.state === state)
      .map((question) =>
        state === "withdrawn" ? `${question.id} (${question.title})` : question.id,
      );
    return ids.length === 0 ? [] : [`${verb} ${ids.join(", ")}`];
  };
  const parts = [
    ...named("withdrawn", "withdrew"),
    ...named("deferred", "deferred"),
    ...named("open", "reopened"),
  ];
  return parts.length === 0 ? "" : `Since your last turn the user ${parts.join("; ")}.`;
}

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly hasQuestionTools?: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly origin?: TurnOrigin | undefined;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools &&
    input.previousState.hasQuestionTools === input.state.hasQuestionTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          ...(input.state.hasQuestionTools ? [T3_CODE_QUESTION_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return withTurnOriginPrefix(
    input.prompt,
    input.origin,
    (body) =>
      `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request>`,
  );
}

const orchestrationInstructions = (hasDeviceTools: boolean, hasQuestionTools: boolean) =>
  [
    T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    ...(hasDeviceTools ? [`${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`] : []),
    ...(hasQuestionTools ? [`${T3_CODE_QUESTION_TOOL_INSTRUCTIONS}\n`] : []),
  ].join("\n");

function prependT3OrchestrationInstructions(
  prompt: string,
  instructions: string,
  origin: TurnOrigin | undefined,
): string {
  return withTurnOriginPrefix(
    prompt,
    origin,
    (body) =>
      `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${body}\n</user_request>`,
  );
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly origin?: TurnOrigin | undefined;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly hasQuestionTools?: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools, input.hasQuestionTools === true),
      input.origin,
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(
        input.prompt,
        T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
        input.origin,
      )
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
  hasQuestionTools = false,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools, hasQuestionTools) : undefined;
}
