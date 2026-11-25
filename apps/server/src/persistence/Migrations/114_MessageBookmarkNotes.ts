import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The user's own note on a bookmark. Servers before this ignore the column. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE message_bookmarks ADD COLUMN note TEXT`;
});
