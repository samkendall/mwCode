import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork-local migration. Slots 900+ are reserved for this fork so upstream's
 * sequential numbering never collides with ours on a shared database.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "work_type")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN work_type TEXT
    `;
  }

  if (!columns.some((column) => column.name === "stage")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN stage TEXT
    `;
  }
});
