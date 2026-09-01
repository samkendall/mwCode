import { DEFAULT_HARNESS_TAXONOMY } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import {
  HARNESS_TAXONOMY_FILE_NAME,
  PROJECT_CONFIG_DIR_NAME,
  loadGlobalHarnessTaxonomy,
  resolveProjectHarnessTaxonomy,
} from "./harnessTaxonomy.ts";

/** Create a scoped temp base dir and optionally seed its global harness file. */
const withBaseDir = <A, E>(
  seed: string | null,
  body: (baseDir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-harness-taxonomy-" });
    if (seed !== null) {
      yield* fs.writeFileString(path.join(baseDir, HARNESS_TAXONOMY_FILE_NAME), seed);
    }
    return yield* body(baseDir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const ids = (entries: ReadonlyArray<{ readonly id: string }>) => entries.map((entry) => entry.id);

describe("harnessTaxonomy loader", () => {
  it.effect("falls back to defaults when no file exists", () =>
    withBaseDir(null, (baseDir) =>
      Effect.gen(function* () {
        const taxonomy = yield* loadGlobalHarnessTaxonomy(baseDir);
        assert.deepEqual(taxonomy, DEFAULT_HARNESS_TAXONOMY);
      }),
    ),
  );

  it.effect("merges a global file by id: overrides one, appends new, keeps the rest", () =>
    withBaseDir(
      `{
        "workTypes": [
          { "id": "bug", "label": "Defect", "color": "#111111", "description": "Renamed." },
          { "id": "chore", "label": "Chore", "color": "#222222" }
        ]
      }`,
      (baseDir) =>
        Effect.gen(function* () {
          const taxonomy = yield* loadGlobalHarnessTaxonomy(baseDir);
          // bug is overridden in place; chore is appended; stages untouched.
          const bug = taxonomy.workTypes.find((entry) => entry.id === "bug");
          assert.equal(bug?.label, "Defect");
          assert.equal(bug?.color, "#111111");
          assert.deepEqual(ids(taxonomy.workTypes), [
            ...ids(DEFAULT_HARNESS_TAXONOMY.workTypes),
            "chore",
          ]);
          assert.deepEqual(taxonomy.stages, DEFAULT_HARNESS_TAXONOMY.stages);
        }),
    ),
  );

  it.effect("project file overrides the global layer for that project", () =>
    withBaseDir(`{ "workTypes": [{ "id": "feature", "label": "Global Feature" }] }`, (baseDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const global = yield* loadGlobalHarnessTaxonomy(baseDir);
        assert.equal(
          global.workTypes.find((entry) => entry.id === "feature")?.label,
          "Global Feature",
        );

        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-project-" });
        const projectDir = path.join(workspaceRoot, PROJECT_CONFIG_DIR_NAME);
        yield* fs.makeDirectory(projectDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(projectDir, HARNESS_TAXONOMY_FILE_NAME),
          `{ "workTypes": [{ "id": "feature", "label": "Project Feature" }] }`,
        );

        const resolved = yield* resolveProjectHarnessTaxonomy(workspaceRoot, global);
        assert.equal(
          resolved.workTypes.find((entry) => entry.id === "feature")?.label,
          "Project Feature",
        );
      }),
    ),
  );

  it.effect("falls back to defaults on malformed JSON without throwing", () =>
    withBaseDir("{ not valid json", (baseDir) =>
      Effect.gen(function* () {
        const taxonomy = yield* loadGlobalHarnessTaxonomy(baseDir);
        assert.deepEqual(taxonomy, DEFAULT_HARNESS_TAXONOMY);
      }),
    ),
  );

  it.effect("rejects a schema-invalid entry and falls back to defaults", () =>
    // Empty id violates TrimmedNonEmptyString; the whole file is skipped.
    withBaseDir(`{ "workTypes": [{ "id": "", "label": "Bad" }] }`, (baseDir) =>
      Effect.gen(function* () {
        const taxonomy = yield* loadGlobalHarnessTaxonomy(baseDir);
        assert.deepEqual(taxonomy, DEFAULT_HARNESS_TAXONOMY);
      }),
    ),
  );
});
