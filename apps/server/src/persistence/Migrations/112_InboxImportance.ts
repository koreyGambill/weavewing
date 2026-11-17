import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The inbox index limits this cleanup to active notifications, even in a large event database.
  yield* sql`UPDATE notifications INDEXED BY idx_notifications_inbox
    SET read_at = coalesce(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      dismissed_at = CASE WHEN severity = 'info'
        OR json_extract(source_json, '$.kind') = 'review'
        OR dedupe_key GLOB '*
evidence:*'
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE dismissed_at END
    WHERE dismissed_at IS NULL`;
});
