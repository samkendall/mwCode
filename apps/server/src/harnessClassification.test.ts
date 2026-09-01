import { DEFAULT_HARNESS_TAXONOMY, type HarnessTaxonomy } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseExplicitWorkType, resolveTaxonomyId } from "./harnessClassification.ts";

const taxonomy: HarnessTaxonomy = DEFAULT_HARNESS_TAXONOMY;

describe("parseExplicitWorkType", () => {
  it("resolves a slash-wrapper tier like /momo feature", () => {
    expect(parseExplicitWorkType("/momo feature add a share button", taxonomy)).toBe("feature");
  });

  it("resolves a bare slash-command tier like /feature", () => {
    expect(parseExplicitWorkType("/feature add a share button", taxonomy)).toBe("feature");
  });

  it("matches a taxonomy label as well as an id", () => {
    // "Bug" is the label; "bug" is the id. Either resolves to the id.
    expect(parseExplicitWorkType("/momo Bug the reconnect loop breaks", taxonomy)).toBe("bug");
  });

  it("resolves an explicit type: prefix", () => {
    expect(parseExplicitWorkType("type: security harden the token store", taxonomy)).toBe(
      "security",
    );
  });

  it("resolves an explicit tier= prefix", () => {
    expect(parseExplicitWorkType("tier=cosmetic nudge the padding", taxonomy)).toBe("cosmetic");
  });

  it("is case-insensitive across command, tier, and prefix", () => {
    expect(parseExplicitWorkType("/MOMO Feature ship it", taxonomy)).toBe("feature");
    expect(parseExplicitWorkType("TYPE: REVIEW look at the PR", taxonomy)).toBe("review");
  });

  it("returns null for an unknown tier after a wrapper", () => {
    expect(parseExplicitWorkType("/momo wizardry do something clever", taxonomy)).toBeNull();
  });

  it("returns null when there is no explicit signal", () => {
    expect(parseExplicitWorkType("please investigate the flaky test", taxonomy)).toBeNull();
  });

  it("returns null for a slash command with no tier and no matching word", () => {
    expect(parseExplicitWorkType("/momo", taxonomy)).toBeNull();
  });

  it("only inspects the first line", () => {
    expect(parseExplicitWorkType("do the thing\n/feature ignored", taxonomy)).toBeNull();
  });

  it("returns null for an empty message", () => {
    expect(parseExplicitWorkType("", taxonomy)).toBeNull();
    expect(parseExplicitWorkType("   \n  ", taxonomy)).toBeNull();
  });
});

describe("resolveTaxonomyId", () => {
  it("returns the canonical id for a valid id", () => {
    expect(resolveTaxonomyId(taxonomy.stages, "building")).toBe("building");
  });

  it("resolves a label to its id, case-insensitively", () => {
    expect(resolveTaxonomyId(taxonomy.workTypes, "Feature")).toBe("feature");
  });

  it("drops an id that is not in the taxonomy", () => {
    expect(resolveTaxonomyId(taxonomy.workTypes, "hallucinated")).toBeNull();
  });

  it("returns null for empty or nullish candidates", () => {
    expect(resolveTaxonomyId(taxonomy.workTypes, "")).toBeNull();
    expect(resolveTaxonomyId(taxonomy.workTypes, "   ")).toBeNull();
    expect(resolveTaxonomyId(taxonomy.workTypes, null)).toBeNull();
    expect(resolveTaxonomyId(taxonomy.workTypes, undefined)).toBeNull();
  });
});
