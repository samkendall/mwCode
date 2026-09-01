/**
 * HarnessTaxonomy — fork-local, runtime-configurable vocabulary for the
 * thread `workType` and `stage` classification fields.
 *
 * A thread stores an opaque `workType`/`stage` id (see `OrchestrationThread`).
 * This taxonomy defines the ALLOWED ids plus their display metadata (label,
 * color) and an optional hint that doubles as an LLM classification cue. It is
 * loaded from disk at runtime so the taxonomy can differ per coding harness
 * without rebuilding — the server merges the on-disk files over
 * {@link DEFAULT_HARNESS_TAXONOMY} and ships the effective set to clients.
 *
 * This module stays pure: schema plus the seed constant only. All file IO and
 * merge logic lives server-side.
 *
 * @module HarnessTaxonomy
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A display color for a taxonomy entry: a 3- or 6-digit CSS hex string. Kept
 * deliberately narrow (rather than "any CSS color") so a config file cannot
 * smuggle arbitrary strings into a spot the UI paints. Optional/nullable: an
 * entry without a color falls back to a neutral swatch client-side.
 */
export const HarnessTaxonomyColor = TrimmedNonEmptyString.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
export type HarnessTaxonomyColor = typeof HarnessTaxonomyColor.Type;

// Annotate on the encoded (string) side and trim on decode so a hand-edited
// config tolerates incidental whitespace, mirroring `t3ProjectFile`.
const trimmed = (description: string) => {
  const annotated = TrimmedNonEmptyString.annotate({ description });
  return annotated.pipe(Schema.decodeTo(annotated, SchemaTransformation.trim()));
};

export const HarnessTaxonomyEntry = Schema.Struct({
  /**
   * Stable id stored on a thread's `workType`/`stage`. Lowercase by
   * convention; matching is exact, so renaming an id orphans threads that
   * still carry the old one.
   */
  id: trimmed("Stable id stored on the thread's workType/stage field."),
  /** Human-readable label shown in the UI. */
  label: trimmed("Human-readable label shown in the UI."),
  /**
   * Display color as a CSS hex string (e.g. "#3b82f6"). Null/absent renders a
   * neutral swatch.
   */
  color: Schema.optional(Schema.NullOr(HarnessTaxonomyColor)),
  /**
   * One-line hint describing when the entry applies. Shown as help text and
   * reusable later as an LLM classification cue. Null/absent means no hint.
   */
  description: Schema.optional(
    Schema.NullOr(trimmed("One-line hint describing when this entry applies.")),
  ),
});
export type HarnessTaxonomyEntry = typeof HarnessTaxonomyEntry.Type;

export const HarnessTaxonomy = Schema.Struct({
  /** Allowed values for a thread's `workType` (what kind of change it is). */
  workTypes: Schema.Array(HarnessTaxonomyEntry),
  /** Allowed values for a thread's `stage` (where in the lifecycle it is). */
  stages: Schema.Array(HarnessTaxonomyEntry),
}).annotate({
  title: "Harness taxonomy",
  description: "Runtime-configurable work-type and stage options for thread classification.",
});
export type HarnessTaxonomy = typeof HarnessTaxonomy.Type;

/**
 * Seed taxonomy applied before any on-disk config. The server merges a global
 * (`<baseDir>/harness.json`) and per-project (`<workspaceRoot>/.mwcode/harness.json`)
 * file over this by id (see the server loader for the exact rule).
 */
export const DEFAULT_HARNESS_TAXONOMY: HarnessTaxonomy = {
  workTypes: [
    {
      id: "feature",
      label: "Feature",
      color: "#3b82f6",
      description: "New capability or user-facing functionality.",
    },
    {
      id: "bug",
      label: "Bug",
      color: "#ef4444",
      description: "Fixing incorrect or broken behavior.",
    },
    {
      id: "tweak",
      label: "Tweak",
      color: "#f59e0b",
      description: "Small adjustment to existing behavior.",
    },
    {
      id: "cosmetic",
      label: "Cosmetic",
      color: "#ec4899",
      description: "Visual or styling change with no logic impact.",
    },
    {
      id: "review",
      label: "Review",
      color: "#8b5cf6",
      description: "Reviewing or auditing existing code.",
    },
    {
      id: "security",
      label: "Security",
      color: "#dc2626",
      description: "Addressing a vulnerability or hardening the system.",
    },
  ],
  stages: [
    {
      id: "research",
      label: "Research",
      color: "#64748b",
      description: "Gathering context and understanding the problem.",
    },
    {
      id: "discussion",
      label: "Discussion",
      color: "#0ea5e9",
      description: "Talking through the approach and tradeoffs.",
    },
    {
      id: "brainstorming",
      label: "Brainstorming",
      color: "#a855f7",
      description: "Generating ideas and possibilities.",
    },
    {
      id: "planning",
      label: "Planning",
      color: "#14b8a6",
      description: "Sequencing the work into concrete steps.",
    },
    {
      id: "specing",
      label: "Specing",
      color: "#6366f1",
      description: "Writing a detailed specification.",
    },
    {
      id: "building",
      label: "Building",
      color: "#22c55e",
      description: "Implementing the change.",
    },
    {
      id: "tweaking",
      label: "Tweaking",
      color: "#eab308",
      description: "Refining and polishing the implementation.",
    },
  ],
};
