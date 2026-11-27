import {
  CommandId,
  EVIDENCE_PROMPT_ORIGIN_EVENT,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  shellScript,
  shellSegments,
  withoutHeredocBodies,
} from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EvidenceService from "./EvidenceService.ts";

type Target = Pick<EvidenceService.LandingTarget, "branch" | "remote">;
type LandingKind = "merge" | "push" | "pr-merge" | "land";

/** The reflog subjects each kind of landing command leaves on the refs it moves. */
const LANDING_MOVES: Record<LandingKind, EvidenceService.LandingWindow["moves"]> = {
  merge: [{ ref: "branch", subject: /^(?:merge |commit \(merge\))/u }],
  push: [{ ref: "remote", subject: /^update by push/u }],
  // `gh pr merge` merges on the forge; only its local sync of the default branch is visible here.
  "pr-merge": [{ ref: "branch", subject: /^(?:pull|merge )/u }],
  land: [
    { ref: "branch", subject: /^merge /u },
    { ref: "remote", subject: /^update by push/u },
  ],
};

const MERGE_VALUE_OPTIONS = new Set(["-m", "-s", "-X", "-F", "--file", "--strategy"]);
const WRAPPERS = new Set(["env", "time", "nohup", "command"]);

/** Whether `ref` names the target branch or where it comes from, so merging it is a refresh. */
const namesTargetSource = (ref: string, target: Target) =>
  [
    target.branch,
    `refs/heads/${target.branch}`,
    "FETCH_HEAD",
    "@{u}",
    "@{upstream}",
    `${target.remote ?? "origin"}/HEAD`,
  ].includes(ref) || ref.endsWith(`/${target.branch}`);

/** A shell command's words, unquoted, without a trailing comment. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? "";
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') word += segment[++index] ?? "";
      else word += char;
      continue;
    }
    if (char === "#" && !started) break;
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      word += segment[++index] ?? "";
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** The directory a git command names with a global `-C`, if any. */
function gitDirectory(command: ReadonlyArray<string>) {
  if (command[0] !== "git") return undefined;
  let dir: string | undefined;
  for (let index = 1; command[index] === "-C" || command[index] === "-c"; index += 2)
    if (command[index] === "-C") dir = command[index + 1] ?? "";
  return dir;
}

/** The arguments of an option that takes one, as `--delivery x` or `--delivery=x`. */
const optionValue = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index === -1
    ? args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    : args[index + 1];
};

/**
 * The landing kind a command's words run, given the project's target, or null. Without a target,
 * any command that could land on some branch. A miss costs nothing, while a false match costs the
 * agent a turn, so each rule is narrow.
 */
function landingKind(words: ReadonlyArray<string>, target: Target | null): LandingKind | null {
  const [program, ...rest] = words;
  if (program === "gh" && rest[0] === "pr" && rest[1] === "merge") {
    const args = rest.slice(2);
    // `--auto` only queues the merge for later.
    return ["--auto", "--help", "-h", "--disable-auto"].some((flag) => args.includes(flag))
      ? null
      : "pr-merge";
  }
  if (program === "xwing" && rest[0] === "env" && rest[1] === "land") {
    const args = rest.slice(2);
    return args.includes("--dry-run") || optionValue(args, "--delivery") === "pull-request"
      ? null
      : "land";
  }
  if (program !== "git") return null;
  let index = 0;
  while (rest[index] === "-C" || rest[index] === "-c") index += 2;
  const [subcommand, ...args] = rest.slice(index);
  if (subcommand === "merge") {
    if (args.includes("--abort") || args.includes("--quit") || args.includes("--no-commit"))
      return null;
    const refs = args.filter(
      (arg, at) => !arg.startsWith("-") && !MERGE_VALUE_OPTIONS.has(args[at - 1] ?? ""),
    );
    if (refs.length === 0) return args.includes("--continue") ? "merge" : null;
    return target === null || refs.some((ref) => !namesTargetSource(ref, target)) ? "merge" : null;
  }
  if (subcommand === "push") {
    if (args.some((arg) => ["-d", "--delete", "-n", "--dry-run"].includes(arg))) return null;
    const [remote, ...refspecs] = args.filter((arg) => !arg.startsWith("-"));
    if (target === null) return refspecs.length > 0 ? "push" : null;
    // Only a push to the project's own remote moves the remote-tracking branch read here.
    if (target.remote === null || remote !== target.remote) return null;
    return refspecs.some((refspec) => {
      const destination = (refspec.split(":").at(-1) ?? "").replace(/^\+/u, "");
      return destination === target.branch || destination === `refs/heads/${target.branch}`;
    })
      ? "push"
      : null;
  }
  return null;
}

/**
 * The landing commands a shell input runs, with the absolute directory each names through
 * `git -C` or an earlier `cd`, or null for the thread's own checkout. Text a command carries, in
 * quotes, comments or heredocs, is not a command; a relative `-C` is skipped as unknown.
 */
export function landingCommands(
  input: string,
  target: Target | null,
): ReadonlyArray<{ readonly kind: LandingKind; readonly dir: string | null }> {
  let cwd: string | null = null;
  return shellSegments(withoutHeredocBodies(shellScript(input))).flatMap((segment) => {
    const words = shellWords(
      segment
        .trim()
        .replace(/^[({\s]+/u, "")
        .replace(/[)}\s]+$/u, ""),
    );
    let start = 0;
    while (
      start < words.length &&
      (/^\w+=/u.test(words[start] ?? "") || WRAPPERS.has(words[start] ?? ""))
    )
      start++;
    if (words[start] === "timeout") start += 2;
    const command = words.slice(start);
    if (command[0] === "cd") {
      const dir = command[1];
      if (dir?.startsWith("/")) cwd = dir;
      return [];
    }
    const kind = landingKind(command, target);
    if (kind === null) return [];
    const named = gitDirectory(command);
    if (named === undefined) return [{ kind, dir: cwd }];
    return named.startsWith("/") ? [{ kind, dir: named }] : [];
  });
}

type CommandExecution = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

// Claude reports no exit code; it marks a failed command's item `failed` instead.
const succeeded = (item: CommandExecution) =>
  item.status === "completed" &&
  (item.exitCode === undefined || item.exitCode === 0) &&
  item.outputIndicatesFailure !== true;

const isEvidencePrompt = (message: OrchestrationV2ConversationMessage) =>
  message.origin?.kind === "system" && message.origin.event === EVIDENCE_PROMPT_ORIGIN_EVENT;

/** The done prompt's text. */
export function evidencePromptText(branch: string, shas: ReadonlyArray<string>): string {
  const shown = shas.slice(0, 5).map((sha) => sha.slice(0, 7));
  const more = shas.length - shown.length;
  const list = more > 0 ? [...shown, `and ${more} more`] : shown;
  return `Work landed on ${branch} in your last turn (${list.join(", ")}) and no evidence covers it. Call evidence_record for it, or evidence_record with exempt.reason to say why none is needed.`;
}

export class EvidencePromptService extends Context.Service<
  EvidencePromptService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Reacts to a run reaching a terminal status: resolves the outcome of a done prompt the run
     * answered, or, for a completed run that landed uncovered commits, claims them and queues the
     * done prompt's delivery in the same transaction.
     */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/evidence/EvidencePromptService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const evidence = yield* EvidenceService.EvidenceService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const outbox = yield* EffectOutbox.EffectOutboxV2;

  // Each prompted commit is answered by a landing recorded in its project since the prompt that
  // names it, or by one whose target names a newer commit of the same move.
  const resolveOutcomes = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageIds: ReadonlyArray<MessageId>,
  ) {
    const rows = yield* sql<{
      readonly project_id: ProjectId;
      readonly target_sha: string;
      readonly message_id: string;
      readonly move: number;
      readonly prompted_at: string;
    }>`SELECT project_id, target_sha, message_id, move, prompted_at FROM evidence_prompts
        WHERE thread_id = ${threadId} AND outcome = 'sent' AND message_id IN ${sql.in(messageIds)}
        ORDER BY message_id, move, position`;
    for (const move of Map.groupBy(rows, (row) => `${row.message_id}:${row.move}`).values()) {
      const [first] = move;
      if (first === undefined) continue;
      const recorded = yield* evidence.recordedRefs({
        projectId: first.project_id,
        since: first.prompted_at,
      });
      const covers = EvidenceService.coveringLandings(
        move.map((row) => ({ sha: row.target_sha, brought: [] })),
        recorded,
      );
      for (const [index, row] of move.entries()) {
        const cover = covers[index];
        const outcome = cover === undefined ? "ignored" : cover.exempt ? "exempt" : "recorded";
        yield* sql`UPDATE evidence_prompts SET outcome = ${outcome}
          WHERE project_id = ${row.project_id} AND target_sha = ${row.target_sha} AND outcome = 'sent'`;
      }
    }
  });

  const evaluate = Effect.fn("EvidencePromptService.evaluate")(function* (run: OrchestrationV2Run) {
    const threadId = run.threadId;
    const inputs = yield* projections.getRunInputMessages(threadId, run.id);
    const prompts = inputs.filter(isEvidencePrompt);
    // The run that answers a prompt is never evaluated itself.
    if (prompts.length > 0)
      return yield* resolveOutcomes(
        threadId,
        prompts.map((message) => message.id),
      );
    if (run.status !== "completed") return;
    // Read again at delivery; checking here first skips the Git work.
    if (!(yield* settings.getSettings).evidencePromptEnabled) return;
    const records = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunId: run.id,
    });
    const { thread } = records;
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    const ran = records.turnItems.filter(
      (item): item is CommandExecution =>
        item.type === "command_execution" &&
        item.runId === run.id &&
        item.startedAt !== null &&
        item.completedAt !== null &&
        succeeded(item) &&
        landingCommands(item.input, null).length > 0,
    );
    if (ran.length === 0) return;
    const target = yield* evidence.landingTarget(thread.projectId);
    if (target === null) return;
    const windows = ran.flatMap((item) =>
      landingCommands(item.input, target).map((command) => ({
        fromMs: DateTime.toEpochMillis(item.startedAt!),
        toMs: DateTime.toEpochMillis(item.completedAt!),
        dir: command.dir,
        moves: LANDING_MOVES[command.kind],
      })),
    );
    if (windows.length === 0) return;
    const moves = yield* evidence.landedMoves({ target, windows });
    if (moves.length === 0) return;
    const projectId = thread.projectId;
    const promptedAt = DateTime.formatIso(yield* DateTime.now);
    const claimed = yield* sql.withTransaction(
      Effect.gen(function* () {
        // Coverage is read again here, so evidence recorded during the Git work stops the prompt.
        const recorded = yield* evidence.recordedRefs({ projectId });
        const uncovered = new Map<string, { readonly move: number; readonly position: number }>();
        for (const [moveIndex, move] of moves.entries()) {
          const covers = EvidenceService.coveringLandings(move, recorded);
          for (const [position, commit] of move.entries())
            if (covers[position] === undefined && !uncovered.has(commit.sha))
              uncovered.set(commit.sha, { move: moveIndex, position });
        }
        if (uncovered.size === 0) return false;
        const shas = [...uncovered.keys()];
        const [seen] = yield* sql`SELECT 1 FROM evidence_prompts
          WHERE (project_id = ${projectId} AND target_sha IN ${sql.in(shas)})
            OR (thread_id = ${threadId} AND run_id = ${run.id}) LIMIT 1`;
        if (seen !== undefined) return false;
        const deliveryId = `evidence-prompt:${threadId}:${shas[0]}`;
        const messageId = MessageId.make(deliveryId);
        // The primary key on (project, commit) keeps a second thread's claim from committing.
        for (const [sha, { move, position }] of uncovered)
          yield* sql`INSERT INTO evidence_prompts
              (project_id, target_sha, thread_id, run_id, message_id, move, position, prompted_at, outcome)
            VALUES (${projectId}, ${sha}, ${threadId}, ${run.id}, ${messageId},
              ${move}, ${position}, ${promptedAt}, 'sent')`;
        yield* outbox.enqueue([
          {
            id: `${deliveryId}:deliver`,
            commandId: CommandId.make(deliveryId),
            threadId,
            request: {
              type: "evidence-prompt.deliver",
              projectId,
              messageId,
              text: evidencePromptText(target.branch, shas),
            },
          },
        ]);
        return true;
      }),
    );
    if (claimed) yield* outbox.notifyAvailable(1);
  });

  const handle: EvidencePromptService["Service"]["handle"] = (event) =>
    event.type !== "run.updated" || !ThreadManagement.isTerminalRunStatus(event.payload.status)
      ? Effect.void
      : evaluate(event.payload).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("evaluating a run for the done prompt failed", {
              threadId: event.threadId,
              runId: event.payload.id satisfies RunId,
              cause,
            }),
          ),
        );

  const start: EvidencePromptService["Service"]["start"] = Effect.fn("EvidencePromptService.start")(
    function* () {
      // Each thread's runs are judged in order, so one run's prompt is claimed before the next reads.
      const threadReactions = yield* KeyedLock.makeRunner<ThreadId>();
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          event.type === "run.updated" && ThreadManagement.isTerminalRunStatus(event.payload.status)
            ? threadReactions.run(event.threadId, handle(event))
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("done prompt event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return EvidencePromptService.of({ start, handle });
});

export const layer = Layer.effect(EvidencePromptService, make);
