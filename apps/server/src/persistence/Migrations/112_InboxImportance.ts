import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The inbox index limits this cleanup to active notifications, even in a large event database.
  yield* sql`UPDATE notifications INDEXED BY idx_notifications_inbox
    SET read_at = coalesce(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE dismissed_at IS NULL`;
});
