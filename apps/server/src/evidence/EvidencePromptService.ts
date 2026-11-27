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
  shellSteps,
  withoutHeredocBodies,
} from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EvidenceService from "./EvidenceService.ts";

type Target = Pick<EvidenceService.LandingTarget, "branch" | "remote">;
type LandingKind = "merge" | "push" | "land";

/** One landing step a shell input runs. */
interface LandingStep {
  readonly kind: LandingKind;
  /** The merge's source refs, as its reflog subject names them. */
  readonly sources: ReadonlyArray<string>;
  /** The absolute directory the step runs in, or null for the thread's own checkout. */
  readonly dir: string | null;
  /** Every step of the input is joined by `&&`, so the input's success shows this step ran. */
  readonly proven: boolean;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The reflog subjects a landing step leaves on the refs it moves. */
function stepMoves(step: LandingStep): EvidenceService.LandingWindow["moves"] {
  switch (step.kind) {
    case "merge":
      return [
        {
          ref: "branch",
          subject:
            step.sources.length === 0
              ? /^commit \(merge\)/u
              : new RegExp(`^merge ${escapeRegExp(step.sources.join(" "))}: `, "u"),
        },
      ];
    case "push":
      return [{ ref: "remote", subject: /^update by push$/u }];
    case "land":
      return [
        { ref: "branch", subject: /^merge /u },
        { ref: "remote", subject: /^update by push$/u },
      ];
  }
}

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

/**
 * `dir` resolved against `cwd`: null is the thread's checkout and undefined is unknown. A
 * relative path from the thread's checkout is unknown, since an agent's shell may have moved.
 */
const resolveDir = (cwd: string | null | undefined, dir: string | undefined) => {
  if (dir === undefined || dir === "" || dir === "-" || dir.startsWith("~")) return undefined;
  if (!dir.startsWith("/") && typeof cwd !== "string") return undefined;
  const parts: string[] = [];
  for (const part of `${dir.startsWith("/") ? "" : cwd}/${dir}`.split("/"))
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  return `/${parts.join("/")}`;
};

/** The arguments of an option that takes one, as `--delivery x` or `--delivery=x`. */
const optionValue = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index === -1
    ? args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    : args[index + 1];
};

/**
 * The landing a command's words run, given the project's target, or null. Without a target, any
 * command that could land on some branch. A miss costs nothing, while a false match costs the
 * agent a turn, so each rule is narrow. A forge merge (`gh pr merge`) leaves no local ref move a
 * command can be tied to, so it is not one.
 */
function landingKind(
  words: ReadonlyArray<string>,
  target: Target | null,
): Pick<LandingStep, "kind" | "sources"> | null {
  const [program, ...rest] = words;
  if (program === "xwing" && rest[0] === "env" && rest[1] === "land") {
    const args = rest.slice(2);
    return args.includes("--dry-run") || optionValue(args, "--delivery") === "pull-request"
      ? null
      : { kind: "land", sources: [] };
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
    if (refs.length === 0)
      return args.includes("--continue") ? { kind: "merge", sources: [] } : null;
    return target === null || refs.some((ref) => !namesTargetSource(ref, target))
      ? { kind: "merge", sources: refs }
      : null;
  }
  if (subcommand === "push") {
    if (args.some((arg) => ["-d", "--delete", "-n", "--dry-run"].includes(arg))) return null;
    const [remote, ...refspecs] = args.filter((arg) => !arg.startsWith("-"));
    if (target === null) return refspecs.length > 0 ? { kind: "push", sources: [] } : null;
    // Only a push to the project's own remote moves the remote-tracking branch read here.
    if (target.remote === null || remote !== target.remote) return null;
    return refspecs.some((refspec) => {
      const destination = (refspec.split(":").at(-1) ?? "").replace(/^\+/u, "");
      return destination === target.branch || destination === `refs/heads/${target.branch}`;
    })
      ? { kind: "push", sources: [] }
      : null;
  }
  return null;
}

/**
 * The landing steps a shell input runs. Text a command carries, in quotes, comments or heredocs,
 * is not a command. A step's directory comes from `git -C` or an earlier `cd` or `pushd`; one
 * that cannot be resolved to an absolute path drops the step.
 */
export function landingSteps(input: string, target: Target | null): ReadonlyArray<LandingStep> {
  const steps = shellSteps(withoutHeredocBodies(shellScript(input))).filter(
    (step) => step.segment.trim() !== "",
  );
  const proven = steps.slice(0, -1).every((step) => step.separator === "&&");
  let cwd: string | null | undefined = null;
  return steps.flatMap(({ segment }) => {
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
    if (command[0] === "cd" || command[0] === "pushd") {
      cwd = resolveDir(cwd, command[1]);
      return [];
    }
    if (command[0] === "popd") {
      cwd = undefined;
      return [];
    }
    const landing = landingKind(command, target);
    if (landing === null) return [];
    const named = gitDirectory(command);
    const dir = named === undefined ? cwd : resolveDir(cwd, named);
    return dir === undefined ? [] : [{ ...landing, dir, proven }];
  });
}

// `Updating a..b` from a merge and `a..b  HEAD -> main` from a push: the moves an output reports.
const REPORTED_MOVE = /^(?:Updating |\s*[+*]?\s*)([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})\b/gmu;

/**
 * Whether a step's own output ties it to a ref move. An output that reports moves must report
 * this one. Without one, a proven step counts, and so does a merge whose output says it merged.
 */
function stepMadeMove(
  step: LandingStep,
  output: string,
  move: Pick<EvidenceService.LandedMove, "from" | "to">,
) {
  const reported = [...output.matchAll(REPORTED_MOVE)];
  if (reported.length > 0)
    return reported.some(
      ([, from = "", to = ""]) => move.from.startsWith(from) && move.to.startsWith(to),
    );
  return step.proven || (step.kind === "merge" && /^Merge made by /mu.test(output));
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

  /**
   * Whether another thread of the project ran a command in the move's second that could have made
   * it: one still running, or one done whose own output ties it to the move. Then the move is
   * ambiguous and nobody is asked about it.
   */
  const anotherThreadMayHaveMade = Effect.fnUntraced(function* (
    move: EvidenceService.LandedMove,
    context: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly target: Target;
    },
  ) {
    const from = DateTime.formatIso(DateTime.makeUnsafe(move.at * 1000));
    const to = DateTime.formatIso(DateTime.makeUnsafe(move.at * 1000 + 999));
    const rows = yield* sql<{ readonly payload_json: string }>`SELECT i.payload_json
        FROM orchestration_v2_projection_threads t
        JOIN orchestration_v2_projection_turn_items i ON i.thread_id = t.thread_id
        WHERE t.project_id = ${context.projectId} AND t.thread_id != ${context.threadId}
          AND t.updated_at >= ${from} AND i.type = 'command_execution' AND i.updated_at >= ${from}`;
    return rows.some((row) => {
      const item = JSON.parse(row.payload_json) as Partial<
        Record<"input" | "output" | "status" | "startedAt" | "completedAt", string | null>
      > & { readonly exitCode?: number; readonly outputIndicatesFailure?: boolean };
      if (!item.input || !item.startedAt || item.startedAt > to) return false;
      if (item.completedAt && item.completedAt < from) return false;
      const steps = landingSteps(item.input, context.target).filter((step) =>
        stepMoves(step).some(({ subject }) => subject.test(move.subject)),
      );
      if (steps.length === 0) return false;
      if (item.status !== "completed" && item.status !== "failed") return true;
      const ok =
        item.status === "completed" &&
        (item.exitCode === undefined || item.exitCode === 0) &&
        item.outputIndicatesFailure !== true;
      return ok && steps.some((step) => stepMadeMove(step, item.output ?? "", move));
    });
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
        landingSteps(item.input, null).length > 0,
    );
    if (ran.length === 0) return;
    const target = yield* evidence.landingTarget(thread.projectId);
    if (target === null) return;
    const projectId = thread.projectId;
    const steps = ran.flatMap((item) =>
      landingSteps(item.input, target).map((step) => ({ item, step })),
    );
    if (steps.length === 0) return;
    const found = yield* evidence.landedMoves({
      target,
      windows: steps.map(({ item, step }) => ({
        fromMs: DateTime.toEpochMillis(item.startedAt!),
        toMs: DateTime.toEpochMillis(item.completedAt!),
        dir: step.dir,
        moves: stepMoves(step),
      })),
    });
    const moves: Array<EvidenceService.LandedMove> = [];
    for (const move of found) {
      const tied = move.windows.some((index) => {
        const candidate = steps[index];
        return (
          candidate !== undefined && stepMadeMove(candidate.step, candidate.item.output ?? "", move)
        );
      });
      if (tied && !(yield* anotherThreadMayHaveMade(move, { projectId, threadId, target })))
        moves.push(move);
    }
    if (moves.length === 0) return;
    const promptedAt = DateTime.formatIso(yield* DateTime.now);
    const claimed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [runClaimed] = yield* sql`SELECT 1 FROM evidence_prompts
          WHERE thread_id = ${threadId} AND run_id = ${run.id} LIMIT 1`;
        if (runClaimed !== undefined) return false;
        // Coverage is read again here, so evidence recorded during the Git work stops the prompt.
        const recorded = yield* evidence.recordedRefs({ projectId });
        const candidates = moves.flatMap((move) => move.commits.map((commit) => commit.sha));
        // A commit another prompt already asked about is left out; the rest are still asked about.
        const seen = new Set(
          candidates.length === 0
            ? []
            : (yield* sql<{ readonly target_sha: string }>`SELECT target_sha FROM evidence_prompts
                WHERE project_id = ${projectId} AND target_sha IN ${sql.in(candidates)}`).map(
                (row) => row.target_sha,
              ),
        );
        const uncovered = new Map<string, { readonly move: number; readonly position: number }>();
        for (const [moveIndex, move] of moves.entries()) {
          const covers = EvidenceService.coveringLandings(move.commits, recorded);
          for (const [position, commit] of move.commits.entries())
            if (
              covers[position] === undefined &&
              !seen.has(commit.sha) &&
              !uncovered.has(commit.sha)
            )
              uncovered.set(commit.sha, { move: moveIndex, position });
        }
        if (uncovered.size === 0) return false;
        const shas = [...uncovered.keys()];
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
