/**
 * Pure helpers for first-turn thread classification.
 *
 * Two concerns live here, both free of IO so they are trivially testable:
 *   1. {@link parseExplicitWorkType} — a conservative cheap parse of the first
 *      user message that resolves a work type WITHOUT an LLM when the user
 *      spelled one out (a leading slash tier like `/momo feature ...`, or a
 *      `type:`/`tier:` prefix). It overrides the model, so it only ever
 *      returns a confident, exact taxonomy match.
 *   2. {@link resolveTaxonomyId} — validates a candidate id (from the parser or
 *      the model) against a taxonomy dimension, returning the canonical id or
 *      null. This is the single gate that stops a hallucinated or stale id from
 *      being persisted.
 *
 * @module HarnessClassification
 */
import type { HarnessTaxonomy, HarnessTaxonomyEntry } from "@t3tools/contracts";

/**
 * Match a raw token against a taxonomy dimension by id or label, case- and
 * whitespace-insensitive. Returns the canonical id, or null when nothing
 * matches exactly. Matching is exact (never fuzzy) so the cheap parse stays
 * conservative.
 */
function matchEntryToken(
  entries: ReadonlyArray<HarnessTaxonomyEntry>,
  token: string,
): string | null {
  const needle = token.trim().toLowerCase();
  if (needle.length === 0) return null;
  for (const entry of entries) {
    if (entry.id.toLowerCase() === needle || entry.label.trim().toLowerCase() === needle) {
      return entry.id;
    }
  }
  return null;
}

/**
 * Validate a candidate work-type/stage id against a taxonomy dimension,
 * returning the canonical id when it is a member and null otherwise. Callers
 * pass the model's raw output through this before persisting so an id that is
 * not in the effective taxonomy is dropped rather than written to the thread.
 */
export function resolveTaxonomyId(
  entries: ReadonlyArray<HarnessTaxonomyEntry>,
  candidate: string | null | undefined,
): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  return matchEntryToken(entries, trimmed);
}

const EXPLICIT_TYPE_PREFIX = /^\s*(?:work\s*type|type|tier)\s*[:=]\s*([A-Za-z0-9_-]+)/i;

/**
 * Resolve a work type from an explicit signal in the first user message, or
 * null when there is none. Deliberately conservative — only exact taxonomy
 * matches count, because this result overrides the model.
 *
 * Recognised, in order:
 *   1. A leading slash command whose command word is itself a work type
 *      (`/feature ...`).
 *   2. A leading slash wrapper followed by a tier word (`/momo feature ...`),
 *      where the wrapper is not a work type but the next word is.
 *   3. A `type:` / `workType:` / `tier:` prefix (`type: bug`).
 */
export function parseExplicitWorkType(message: string, taxonomy: HarnessTaxonomy): string | null {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return null;

  if (firstLine.startsWith("/")) {
    const tokens = firstLine.split(/\s+/);
    // Command word (slash stripped), then the following tier word.
    const commandWord = tokens[0]?.slice(1) ?? "";
    const fromCommand = matchEntryToken(taxonomy.workTypes, commandWord);
    if (fromCommand) return fromCommand;
    const tierWord = tokens[1] ?? "";
    const fromTier = matchEntryToken(taxonomy.workTypes, tierWord);
    if (fromTier) return fromTier;
    return null;
  }

  const prefixMatch = EXPLICIT_TYPE_PREFIX.exec(firstLine);
  if (prefixMatch?.[1]) {
    return matchEntryToken(taxonomy.workTypes, prefixMatch[1]);
  }

  return null;
}
