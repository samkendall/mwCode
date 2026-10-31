import { describe, expect, it } from "vite-plus/test";

import { buildThreadClassificationPrompt } from "./textGenerationPrompts.ts";
import { normalizeClassificationResult, normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildThreadClassificationPrompt", () => {
  const workTypes = [
    { id: "feature", label: "Feature", description: "New capability." },
    { id: "bug", label: "Bug", description: "Fix broken behavior." },
  ];
  const stages = [
    { id: "research", label: "Research", description: "Gathering context." },
    { id: "building", label: "Building", description: "Implementing the change." },
  ];

  it("lists allowed ids with hints and the user message", () => {
    const result = buildThreadClassificationPrompt({
      message: "Add a share button to the toolbar",
      workTypes,
      stages,
      includeWorkType: true,
    });

    expect(result.prompt).toContain("Allowed workType ids:");
    expect(result.prompt).toContain("- feature (Feature): New capability.");
    expect(result.prompt).toContain("Allowed stage ids:");
    expect(result.prompt).toContain("- building (Building): Implementing the change.");
    expect(result.prompt).toContain("Add a share button to the toolbar");
    expect(result.prompt).toContain("Return a JSON object with keys: workType, stage.");
  });

  it("suppresses the work-type decision when it is already known", () => {
    const result = buildThreadClassificationPrompt({
      message: "Add a share button",
      workTypes,
      stages,
      includeWorkType: false,
    });

    expect(result.prompt).toContain("Leave workType as an empty string; it is already known.");
    // The stage list is still offered so the model can pick one.
    expect(result.prompt).toContain("Allowed stage ids:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildThreadClassificationPrompt({
      message: "Match this mock",
      workTypes,
      stages,
      includeWorkType: true,
      attachments: [
        {
          type: "image",
          id: "att-1",
          name: "mock.png",
          mimeType: "image/png",
          sizeBytes: 1024,
        } as never,
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("mock.png");
  });
});

describe("normalizeClassificationResult", () => {
  it("trims values and maps empties to null", () => {
    expect(normalizeClassificationResult({ workType: "  feature ", stage: "" })).toEqual({
      workType: "feature",
      stage: null,
    });
    expect(normalizeClassificationResult({ workType: null, stage: "  " })).toEqual({
      workType: null,
      stage: null,
    });
  });
});
