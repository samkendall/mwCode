import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HARNESS_TAXONOMY,
  HarnessTaxonomy,
  HarnessTaxonomyEntry,
} from "./harnessTaxonomy.ts";

const decode = Schema.decodeUnknownSync(HarnessTaxonomy);
const decodeEntry = Schema.decodeUnknownSync(HarnessTaxonomyEntry);

describe("HarnessTaxonomy", () => {
  it("decodes the default taxonomy", () => {
    const decoded = decode(DEFAULT_HARNESS_TAXONOMY);
    expect(decoded.workTypes.map((entry) => entry.id)).toEqual([
      "feature",
      "bug",
      "tweak",
      "cosmetic",
      "review",
      "security",
    ]);
    expect(decoded.stages.map((entry) => entry.id)).toEqual([
      "research",
      "discussion",
      "brainstorming",
      "planning",
      "specing",
      "building",
      "tweaking",
    ]);
  });

  it("allows an entry without color or description", () => {
    expect(decodeEntry({ id: "chore", label: "Chore" })).toEqual({ id: "chore", label: "Chore" });
  });

  it("trims incidental whitespace in ids and labels", () => {
    expect(decodeEntry({ id: " chore ", label: " Chore " })).toEqual({
      id: "chore",
      label: "Chore",
    });
  });

  it("rejects an empty id", () => {
    expect(() => decodeEntry({ id: "", label: "Bad" })).toThrow();
  });

  it("rejects a non-hex color", () => {
    expect(() => decodeEntry({ id: "x", label: "X", color: "blue" })).toThrow();
  });
});
