/**
 * HarnessTaxonomy loader — resolves the effective thread-classification
 * vocabulary from disk.
 *
 * Layers, innermost last:
 *   1. {@link DEFAULT_HARNESS_TAXONOMY} — the built-in seed.
 *   2. Global file at `<baseDir>/harness.json` (e.g. `~/.mwcode/harness.json`).
 *   3. Per-project file at `<workspaceRoot>/.mwcode/harness.json`.
 *
 * Merge rule (documented once here): entries merge BY ID, not by whole-array
 * replacement. For each dimension (`workTypes`, `stages`), an override entry
 * whose id matches a base entry replaces it in place; an override entry with a
 * new id is appended; a base entry the override never mentions is kept. This
 * makes the common case — "add one work type" or "recolor one stage" — a
 * one-line file instead of forcing the author to restate every default. The
 * cost is that a default cannot be *removed* from a file, only shadowed; that
 * is an acceptable v1 tradeoff.
 *
 * A missing file is silently the identity merge. A malformed or
 * schema-invalid file is logged as a warning and skipped — it never throws and
 * never partially applies — so a bad config degrades to the layer below it
 * rather than taking down config load.
 *
 * @module HarnessTaxonomy
 */
import {
  DEFAULT_HARNESS_TAXONOMY,
  type HarnessTaxonomy,
  type HarnessTaxonomyEntry,
  HarnessTaxonomyEntry as HarnessTaxonomyEntrySchema,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Filename of the harness taxonomy config, used for both global and project. */
export const HARNESS_TAXONOMY_FILE_NAME = "harness.json";

/** Directory holding a project's fork-local config, relative to its workspace root. */
export const PROJECT_CONFIG_DIR_NAME = ".mwcode";

/**
 * On-disk shape. Both dimensions are optional so a file may tune just one; an
 * omitted dimension leaves the layer below untouched.
 */
export const HarnessTaxonomyFile = Schema.Struct({
  workTypes: Schema.optionalKey(Schema.Array(HarnessTaxonomyEntrySchema)),
  stages: Schema.optionalKey(Schema.Array(HarnessTaxonomyEntrySchema)),
});
export type HarnessTaxonomyFile = typeof HarnessTaxonomyFile.Type;

const decodeHarnessTaxonomyFileExit = Schema.decodeExit(fromLenientJson(HarnessTaxonomyFile));

/** Merge one dimension's override entries over its base entries, by id. */
function mergeEntries(
  base: ReadonlyArray<HarnessTaxonomyEntry>,
  override: ReadonlyArray<HarnessTaxonomyEntry> | undefined,
): ReadonlyArray<HarnessTaxonomyEntry> {
  if (override === undefined || override.length === 0) return base;
  const overrideById = new Map(override.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const merged: HarnessTaxonomyEntry[] = [];
  for (const entry of base) {
    const replacement = overrideById.get(entry.id);
    merged.push(replacement ?? entry);
    seen.add(entry.id);
  }
  for (const entry of override) {
    if (!seen.has(entry.id)) {
      merged.push(entry);
      seen.add(entry.id);
    }
  }
  return merged;
}

/** Apply a decoded file's dimensions over a base taxonomy. */
export function mergeHarnessTaxonomy(
  base: HarnessTaxonomy,
  override: HarnessTaxonomyFile,
): HarnessTaxonomy {
  return {
    workTypes: mergeEntries(base.workTypes, override.workTypes),
    stages: mergeEntries(base.stages, override.stages),
  };
}

/**
 * Read and decode one harness file. Returns `null` (after a logged warning) if
 * the file is missing, unreadable, or invalid — the caller then keeps the base
 * layer unchanged.
 */
export const loadHarnessTaxonomyFile = Effect.fn("harnessTaxonomy.loadFile")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;

  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return null;

  const raw = yield* fs.readFileString(filePath).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read harness taxonomy file; using defaults.", {
        path: filePath,
        error: cause instanceof Error ? cause.message : String(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  if (raw === null) return null;

  const decoded = decodeHarnessTaxonomyFileExit(raw);
  if (decoded._tag === "Failure") {
    yield* Effect.logWarning("Ignoring malformed harness taxonomy file; using defaults.", {
      path: filePath,
    });
    return null;
  }
  return decoded.value;
});

/**
 * Resolve the global taxonomy: {@link DEFAULT_HARNESS_TAXONOMY} with the file
 * at `<baseDir>/harness.json` merged over it. This is the effective set shipped
 * to clients.
 */
export const loadGlobalHarnessTaxonomy = Effect.fn("harnessTaxonomy.loadGlobal")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const filePath = path.join(baseDir, HARNESS_TAXONOMY_FILE_NAME);
  const file = yield* loadHarnessTaxonomyFile(filePath);
  return file === null
    ? DEFAULT_HARNESS_TAXONOMY
    : mergeHarnessTaxonomy(DEFAULT_HARNESS_TAXONOMY, file);
});

/**
 * Resolve a project's taxonomy: the already-resolved `global` layer with the
 * file at `<workspaceRoot>/.mwcode/harness.json` merged over it.
 */
export const resolveProjectHarnessTaxonomy = Effect.fn("harnessTaxonomy.resolveProject")(function* (
  workspaceRoot: string,
  global: HarnessTaxonomy,
) {
  const path = yield* Path.Path;
  const filePath = path.join(workspaceRoot, PROJECT_CONFIG_DIR_NAME, HARNESS_TAXONOMY_FILE_NAME);
  const file = yield* loadHarnessTaxonomyFile(filePath);
  return file === null ? global : mergeHarnessTaxonomy(global, file);
});
