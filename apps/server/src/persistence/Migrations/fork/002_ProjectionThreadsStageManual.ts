import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork migration on its own tracker; see Migrations.ts. `stage_manual` (INTEGER 0/1) records a
 * stage the user pinned, which locks out per-turn re-assessment. The PRAGMA guard makes a
 * re-run a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "stage_manual")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN stage_manual INTEGER
    `;
  }
});
