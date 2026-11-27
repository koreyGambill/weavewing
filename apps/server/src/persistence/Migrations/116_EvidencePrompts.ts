import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Done prompts: one row per uncovered commit of a project's target branch, so one thread is asked
 * about it once. `move` and `position` order a prompt's commits; `outcome` is `sent` (delivered or
 * owed), `recorded`, `exempt`, `ignored`, `cancelled` or `failed`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS evidence_prompts (
    project_id TEXT NOT NULL,
    target_sha TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    move INTEGER NOT NULL,
    position INTEGER NOT NULL,
    prompted_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    PRIMARY KEY (project_id, target_sha)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS evidence_prompts_run_idx ON evidence_prompts(thread_id, run_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS evidence_prompts_message_idx ON evidence_prompts(message_id)`;
});
