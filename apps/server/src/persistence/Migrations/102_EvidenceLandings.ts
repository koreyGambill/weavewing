import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Agents write landings and the user writes QA, in separate rows, so neither overwrites the other.
  yield* sql`CREATE TABLE evidence_landings (
    landing_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT,
    landed_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_evidence_landings_landed ON evidence_landings(landed_at, landing_id)`;
  yield* sql`CREATE INDEX idx_evidence_landings_thread
    ON evidence_landings(thread_id, landed_at, landing_id)`;
  yield* sql`CREATE TABLE evidence_qa (
    landing_id TEXT NOT NULL REFERENCES evidence_landings(landing_id) ON DELETE CASCADE,
    change_id TEXT NOT NULL,
    state TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (landing_id, change_id)
  )`;
  yield* sql`CREATE INDEX idx_evidence_qa_state ON evidence_qa(state)`;
});
