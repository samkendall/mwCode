import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("900_ProjectionThreadsWorkTypeAndStage", (it) => {
  it.effect("adds the work_type and stage columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(!before.some((column) => column.name === "work_type"));
      assert.ok(!before.some((column) => column.name === "stage"));

      yield* runMigrations({ toMigrationInclusive: 900 });

      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(after.some((column) => column.name === "work_type"));
      assert.ok(after.some((column) => column.name === "stage"));
    }),
  );

  it.effect("is a no-op when the columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      // Re-running the migration body directly proves the PRAGMA guard holds:
      // a second ALTER TABLE ADD COLUMN would fail with "duplicate column".
      const migration = yield* Effect.promise(
        () => import("./900_ProjectionThreadsWorkTypeAndStage.ts"),
      );
      yield* migration.default;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(columns.filter((column) => column.name === "work_type").length, 1);
      assert.strictEqual(columns.filter((column) => column.name === "stage").length, 1);
    }),
  );
});
