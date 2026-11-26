import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  COMMAND_SEPARATOR,
  shellCode,
  shellScript,
} from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EvidenceService from "./EvidenceService.ts";

/** The origin event of the done prompt; a run that takes it as input is never evaluated. */
export const EVIDENCE_PROMPT_EVENT = "evidence prompt";

type Target = Pick<EvidenceService.LandingTarget, "branch" | "remote">;

const GIT = /^git(?:\s+-[cC]\s+\S+)*\s+/u.source;
const MERGE_VALUE_OPTIONS = new Set(["-m", "-s", "-X", "-F", "--file", "--strategy"]);

/** Whether `ref` names the target branch or where it comes from, so merging it is a refresh. */
function namesTargetSource(ref: string, target: Target) {
  const names = [
    target.branch,
    `refs/heads/${target.branch}`,
    "FETCH_HEAD",
    "@{u}",
    "@{upstream}",
    ...(target.remote === null
      ? []
      : [
          `${target.remote}/${target.branch}`,
          `refs/remotes/${target.remote}/${target.branch}`,
          `${target.remote}/HEAD`,
        ]),
  ];
  return names.includes(ref);
}

/**
 * Commands that can land work on a project's target branch, matched on the words a shell runs.
 * A miss costs nothing, while a false match costs the agent a turn, so each rule is narrow:
 * a merge of the target branch or its upstream into a checkout is a refresh, and a push counts
 * only with a refspec whose destination is the target branch.
 */
const LANDING_COMMANDS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
  readonly lands?: (args: ReadonlyArray<string>, target: Target) => boolean;
}> = [
  {
    name: "git merge",
    pattern: new RegExp(`${GIT}merge(?=\\s|$)`, "u"),
    lands: (args, target) => {
      if (args.includes("--abort") || args.includes("--quit")) return false;
      const refs = args.filter(
        (arg, index) =>
          !arg.startsWith("-") && arg !== "''" && !MERGE_VALUE_OPTIONS.has(args[index - 1] ?? ""),
      );
      if (refs.length === 0) return args.includes("--continue");
      return refs.some((ref) => !namesTargetSource(ref, target));
    },
  },
  {
    name: "git push to the target branch",
    pattern: new RegExp(`${GIT}push(?=\\s|$)`, "u"),
    lands: (args, target) => {
      if (args.some((arg) => ["-d", "--delete", "-n", "--dry-run"].includes(arg))) return false;
      const [, ...refspecs] = args.filter((arg) => !arg.startsWith("-"));
      return refspecs.some((refspec) => {
        const destination = (refspec.split(":").at(-1) ?? "").replace(/^\+/u, "");
        return destination === target.branch || destination === `refs/heads/${target.branch}`;
      });
    },
  },
  { name: "gh pr merge", pattern: /^gh\s+pr\s+merge(?=\s|$)/u },
  {
    name: "xwing env land",
    pattern: /^xwing\s+env\s+land(?=\s|$)/u,
    lands: (args) => !args.includes("--dry-run"),
  },
  { name: "sparkwing run land", pattern: /^sparkwing\s+run\s+land(?=\s|$)/u },
];

// Assignments and wrappers a shell runs a command through, as in `GIT_EDITOR=true timeout 60 git merge`.
const COMMAND_PREFIX = /^(?:(?:\w+=\S*|env|time|nohup|timeout\s+\S+)\s+)*/u;

/** Whether a shell input runs a landing command; without a target, any command the list names. */
export function isLandingCommand(input: string, target: Target | null): boolean {
  return shellCode(shellScript(input))
    .split(COMMAND_SEPARATOR)
    .some((segment) => {
      const command = segment.trim().replace(COMMAND_PREFIX, "");
      return LANDING_COMMANDS.some(({ pattern, lands }) => {
        const match = pattern.exec(command);
        if (match === null) return false;
        if (lands === undefined || target === null) return true;
        const args = command.slice(match[0].length).trim().split(/\s+/u).filter(Boolean);
        return lands(args, target);
      });
    });
}

type CommandExecution = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

// Claude reports no exit code; it marks a failed command's item `failed` instead.
const succeeded = (item: CommandExecution) =>
  item.status === "completed" &&
  (item.exitCode === undefined || item.exitCode === 0) &&
  item.outputIndicatesFailure !== true;

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
     * answered, or, for a completed run that landed uncovered commits, sends the done prompt once.
     */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/evidence/EvidencePromptService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const evidence = yield* EvidenceService.EvidenceService;
  const settings = yield* ServerSettings.ServerSettingsService;

  // A landing that names one of the prompt's commits, recorded after it was sent, answers it.
  const resolveOutcomes = Effect.fnUntraced(function* (
    threadId: ThreadId,
    messageIds: ReadonlyArray<MessageId>,
  ) {
    const prompts = yield* sql<{
      readonly message_id: string;
      readonly target_sha: string;
      readonly prompted_at: string;
    }>`SELECT message_id, target_sha, prompted_at FROM evidence_prompts
        WHERE thread_id = ${threadId} AND outcome = 'sent' AND message_id IN ${sql.in(messageIds)}`;
    for (const [messageId, rows] of Map.groupBy(prompts, (row) => row.message_id)) {
      const shas = rows.map((row) => row.target_sha.toLowerCase());
      const landings = yield* sql<{
        readonly shas: string;
        readonly exempt: number;
      }>`SELECT json_array(json_extract(l.record_json, '$.target.sha')) AS shas,
            json_extract(l.record_json, '$.exempt') IS NOT NULL AS exempt
          FROM evidence_landings l WHERE l.updated_at >= ${rows[0]!.prompted_at}
          UNION ALL
          SELECT json_group_array(c.value), 0
          FROM evidence_landings l, json_each(l.record_json, '$.changes') ch, json_each(ch.value, '$.commits') c
          WHERE l.updated_at >= ${rows[0]!.prompted_at} GROUP BY l.landing_id`;
      const answer = landings.find((landing) =>
        (JSON.parse(landing.shas) as Array<string | null>).some(
          (named) =>
            typeof named === "string" &&
            /^[0-9a-f]{4,64}$/iu.test(named) &&
            shas.some((sha) => sha.startsWith(named.toLowerCase())),
        ),
      );
      const outcome = answer === undefined ? "ignored" : answer.exempt ? "exempt" : "recorded";
      yield* sql`UPDATE evidence_prompts SET outcome = ${outcome}
        WHERE thread_id = ${threadId} AND message_id = ${messageId} AND outcome = 'sent'`;
    }
  });

  const evaluate = Effect.fn("EvidencePromptService.evaluate")(function* (run: OrchestrationV2Run) {
    const threadId = run.threadId;
    const inputs = yield* projections.getRunInputMessages(threadId, run.id);
    const prompts = inputs.filter(
      (message) =>
        message.origin?.kind === "system" && message.origin.event === EVIDENCE_PROMPT_EVENT,
    );
    // The run that answers a prompt is never evaluated itself.
    if (prompts.length > 0)
      return yield* resolveOutcomes(
        threadId,
        prompts.map((message) => message.id),
      );
    if (run.status !== "completed" || run.startedAt === null) return;
    if (!(yield* settings.getSettings).evidencePromptEnabled) return;
    const [promptedRun] = yield* sql`SELECT 1 FROM evidence_prompts
      WHERE thread_id = ${threadId} AND run_id = ${run.id} LIMIT 1`;
    if (promptedRun !== undefined) return;
    const records = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunId: run.id,
    });
    const { thread } = records;
    if (thread.archivedAt !== null || thread.deletedAt !== null) return;
    const landings = records.turnItems.filter(
      (item): item is CommandExecution =>
        item.type === "command_execution" &&
        item.runId === run.id &&
        succeeded(item) &&
        isLandingCommand(item.input, null),
    );
    if (landings.length === 0) return;
    const target = yield* evidence.landingTarget(thread.projectId);
    if (target === null) return;
    const runStart = DateTime.toEpochMillis(run.startedAt);
    const runEnd =
      run.completedAt === null
        ? yield* Clock.currentTimeMillis
        : DateTime.toEpochMillis(run.completedAt);
    const windows = landings
      .filter((item) => isLandingCommand(item.input, target))
      .map((item) => ({
        fromMs: item.startedAt === null ? runStart : DateTime.toEpochMillis(item.startedAt),
        toMs: item.completedAt === null ? runEnd : DateTime.toEpochMillis(item.completedAt),
      }));
    if (windows.length === 0) return;
    const uncovered = yield* evidence.uncoveredLanded({ target, windows });
    if (uncovered.length === 0) return;
    const shas = uncovered.map((commit) => commit.sha);
    const deliveryId = `evidence-prompt:${threadId}:${shas[0]}`;
    const messageId = MessageId.make(deliveryId);
    const promptedAt = DateTime.formatIso(yield* DateTime.now);
    const claimed = yield* sql.withTransaction(
      Effect.gen(function* () {
        const [seen] = yield* sql`SELECT 1 FROM evidence_prompts WHERE thread_id = ${threadId}
          AND (run_id = ${run.id} OR target_sha IN ${sql.in(shas)}) LIMIT 1`;
        if (seen !== undefined) return false;
        for (const sha of shas)
          yield* sql`INSERT INTO evidence_prompts (thread_id, target_sha, run_id, message_id, prompted_at, outcome)
            VALUES (${threadId}, ${sha}, ${run.id}, ${messageId}, ${promptedAt}, 'sent')`;
        return true;
      }),
    );
    if (!claimed) return;
    yield* threads
      .sendToThread({
        origin: { kind: "system", event: EVIDENCE_PROMPT_EVENT },
        // Both ids are fixed per uncovered tip, so a retried delivery adds no second message.
        commandId: CommandId.make(deliveryId),
        messageId,
        projectId: thread.projectId,
        threadId,
        text: evidencePromptText(target.branch, shas),
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.catchTags({
          // The thread was archived after the check; the prompt stays recorded and is not resent.
          ThreadManagementThreadArchivedError: () => Effect.void,
        }),
      );
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
