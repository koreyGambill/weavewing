import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * QA cards: who set each QA state, why a change asks for QA, the thread that shows it and its QA
 * number there. Existing rows keep their state, except `failed`, which is now `problem`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (table: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );
  const qaColumns = yield* columns("evidence_qa");
  if (!qaColumns.has("by"))
    yield* sql`ALTER TABLE evidence_qa ADD COLUMN by TEXT NOT NULL DEFAULT 'user'`;
  if (!qaColumns.has("message_id")) yield* sql`ALTER TABLE evidence_qa ADD COLUMN message_id TEXT`;
  if (!qaColumns.has("discussed_message_id"))
    yield* sql`ALTER TABLE evidence_qa ADD COLUMN discussed_message_id TEXT`;
  if (!qaColumns.has("raised_json"))
    yield* sql`ALTER TABLE evidence_qa ADD COLUMN raised_json TEXT`;
  if (!qaColumns.has("ref")) yield* sql`ALTER TABLE evidence_qa ADD COLUMN ref INTEGER`;
  if (!(yield* columns("evidence_landings")).has("qa_thread_id"))
    yield* sql`ALTER TABLE evidence_landings ADD COLUMN qa_thread_id TEXT`;

  yield* sql`UPDATE evidence_qa SET state = 'problem' WHERE state = 'failed'`;

  // A delegated child's landing belongs to its lead: follow subagent parents to the top.
  yield* sql`WITH RECURSIVE up(landing_id, thread_id, depth) AS (
      SELECT landing_id, thread_id, 0 FROM evidence_landings WHERE qa_thread_id IS NULL
      UNION ALL
      SELECT up.landing_id, json_extract(t.payload_json, '$.lineage.parentThreadId'), up.depth + 1
      FROM up JOIN orchestration_v2_projection_threads t ON t.thread_id = up.thread_id
      WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
        AND up.depth < 16)
    UPDATE evidence_landings SET qa_thread_id = (
      SELECT thread_id FROM up WHERE up.landing_id = evidence_landings.landing_id
      ORDER BY depth DESC LIMIT 1)
    WHERE qa_thread_id IS NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_evidence_landings_qa_thread
    ON evidence_landings(qa_thread_id, landed_at, landing_id)`;

  // Number every change in its QA thread in landing order, then record order, after any numbered.
  yield* sql`WITH numbered AS (
      SELECT q.landing_id, q.change_id,
        (SELECT coalesce(max(q2.ref), 0) FROM evidence_qa q2
          JOIN evidence_landings l2 ON l2.landing_id = q2.landing_id
          WHERE l2.qa_thread_id = l.qa_thread_id) +
        row_number() OVER (PARTITION BY l.qa_thread_id
          ORDER BY l.landed_at, l.landing_id, coalesce(c.key, 0)) AS ref
      FROM evidence_qa q
      JOIN evidence_landings l ON l.landing_id = q.landing_id
      LEFT JOIN json_each(l.record_json, '$.changes') c
        ON json_extract(c.value, '$.id') = q.change_id
      WHERE q.ref IS NULL)
    UPDATE evidence_qa SET ref = (
      SELECT ref FROM numbered
      WHERE numbered.landing_id = evidence_qa.landing_id AND numbered.change_id = evidence_qa.change_id)
    WHERE ref IS NULL`;
});
