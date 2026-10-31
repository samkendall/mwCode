import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork migration on its own tracker (`effect_sql_migrations_fork`); see Migrations.ts.
 * The PRAGMA guard makes a re-run a no-op, since a second ADD COLUMN would fail.
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
