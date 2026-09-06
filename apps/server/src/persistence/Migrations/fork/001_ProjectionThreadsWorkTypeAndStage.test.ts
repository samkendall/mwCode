import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { FORK_MIGRATIONS_TABLE, runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork/001_ProjectionThreadsWorkTypeAndStage", (it) => {
  it.effect("adds the work_type and stage columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "work_type"));
      assert.ok(columns.some((column) => column.name === "stage"));
    }),
  );

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      // A second full run must not attempt a duplicate ALTER TABLE; the fork
      // Migrator sees id 1 already recorded and the guard in the body holds.
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(columns.filter((column) => column.name === "work_type").length, 1);
      assert.strictEqual(columns.filter((column) => column.name === "stage").length, 1);
    }),
  );

  it.effect("tracks fork migrations in a separate table from upstream", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      // Upstream ids live in effect_sql_migrations; the fork id lives only in
      // effect_sql_migrations_fork. The two sequences never share a table, so a
      // fork id can never shadow a future upstream migration.
      const upstream = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      const fork = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;

      assert.ok(upstream.length >= 43);
      assert.ok(
        !upstream.some(
          (row) =>
            Number(row.migration_id) === 1 &&
            row.name.startsWith("ProjectionThreadsWorkTypeAndStage"),
        ),
      );
      assert.deepEqual(
        fork.map((row) => [Number(row.migration_id), row.name]),
        [
          [1, "ProjectionThreadsWorkTypeAndStage"],
          [2, "ProjectionThreadsStageManual"],
        ],
      );
    }),
  );
});
