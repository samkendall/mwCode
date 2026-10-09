import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerEventSink = EventSink.layer.pipe(Layer.provide(layerStores));
const layerTest = Layer.mergeAll(
  layerStores,
  layerEventSink,
  LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, layerEventSink))),
);

// Fork-local: the fork classified v1 threads in its own columns, which must
// survive the one-time import into orchestration v2.
it.layer(layerTest)("LegacyV1ThreadImporter classification", (it) => {
  it.effect("carries workType, stage and stageManual onto imported threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const classified = ThreadId.make("thread:legacy-classified");
      const plain = ThreadId.make("thread:legacy-plain");

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project:legacy-classified', 'Legacy project', '/tmp/legacy-classified',
          '{"instanceId":"codex","model":"gpt-5.4"}', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', NULL
        )
      `;
      for (const row of [
        { id: classified, workType: "feature", stage: "building", stageManual: 1 },
        { id: plain, workType: null, stage: null, stageManual: null },
      ]) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at, deleted_at,
            work_type, stage, stage_manual
          ) VALUES (
            ${row.id}, 'project:legacy-classified', 'Migrated conversation',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', NULL, NULL,
            ${row.workType}, ${row.stage}, ${row.stageManual}
          )
        `;
      }

      const result = yield* importer.reconcileShells;
      assert.equal(result.importedThreadCount, 2);

      const shell = yield* projections.getThreadShell(classified);
      assert.equal(shell?.workType, "feature");
      assert.equal(shell?.stage, "building");
      assert.equal(shell?.stageManual, true);

      const plainThread = yield* projections.getThread(plain);
      assert.isUndefined(plainThread.workType);
      assert.isUndefined(plainThread.stage);
      assert.isUndefined(plainThread.stageManual);
    }),
  );
});
