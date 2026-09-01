import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork-local migration #1. Fork migrations run through a SEPARATE Migrator with
 * its own tracking table (`effect_sql_migrations_fork`), numbered from 1, so
 * they never share upstream's sequence. See Migrations.ts for why the split
 * matters.
 *
 * Guarded with PRAGMA table_info so a re-run is a no-op (a second
 * ALTER TABLE ADD COLUMN would fail with "duplicate column").
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
