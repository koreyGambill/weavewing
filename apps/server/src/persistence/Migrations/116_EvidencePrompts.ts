import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Done prompts: one row per uncovered commit a thread was asked to record evidence for, with the
 * run that landed it, the prompt message and its outcome (`sent`, `recorded`, `exempt`, `ignored`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS evidence_prompts (
    thread_id TEXT NOT NULL,
    target_sha TEXT NOT NULL,
    run_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    prompted_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    PRIMARY KEY (thread_id, target_sha)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS evidence_prompts_run_idx ON evidence_prompts(thread_id, run_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS evidence_prompts_message_idx
    ON evidence_prompts(thread_id, message_id)`;
});
