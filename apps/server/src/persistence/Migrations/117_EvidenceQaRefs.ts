import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The highest QA number each lead thread has handed out, so a number a removed change once showed
 * is never given to another. Seeded from every stored number, settled and quiet rows included.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS evidence_qa_refs (
    qa_thread_id TEXT PRIMARY KEY,
    last_ref INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO evidence_qa_refs (qa_thread_id, last_ref)
    SELECT coalesce(l.qa_thread_id, l.thread_id), max(q.ref)
    FROM evidence_qa q JOIN evidence_landings l ON l.landing_id = q.landing_id
    WHERE q.ref IS NOT NULL
    GROUP BY coalesce(l.qa_thread_id, l.thread_id)
    ON CONFLICT (qa_thread_id) DO UPDATE SET last_ref = max(last_ref, excluded.last_ref)`;
});
