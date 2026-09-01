import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { FORK_MIGRATIONS_TABLE, runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "../../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork/002_ProjectionThreadsStageManual", (it) => {
  it.effect("adds the stage_manual column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "stage_manual"));
    }),
  );

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      // A second full run must not attempt a duplicate ALTER TABLE; the fork
      // Migrator sees id 2 already recorded and the guard in the body holds.
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(columns.filter((column) => column.name === "stage_manual").length, 1);
    }),
  );

  it.effect("records fork ids 1 and 2 in the separate fork tracking table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const fork = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;
      assert.deepEqual(
        fork.map((row) => [Number(row.migration_id), row.name]),
        [
          [1, "ProjectionThreadsWorkTypeAndStage"],
          [2, "ProjectionThreadsStageManual"],
        ],
      );

      // The fork ids must never leak into the upstream tracking table.
      const upstream = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.ok(
        !upstream.some(
          (row) =>
            Number(row.migration_id) === 2 && row.name.startsWith("ProjectionThreadsStageManual"),
        ),
      );
    }),
  );
});
