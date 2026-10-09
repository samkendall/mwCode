import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGenerationOperations from "./textGenerationOperations.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const workTypes = [{ id: "feature", label: "Feature" }];
const stages = [{ id: "building", label: "Building" }];

// Fork-local: every runner-backed provider classifies threads through this.
describe("fromRunner classifyThread", () => {
  it.effect("sends the classification prompt and normalizes the reply", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly operation: string; readonly prompt: string }> = [];
      const generation = TextGenerationOperations.fromRunner("Test", ((request) => {
        requests.push({ operation: request.operation, prompt: request.prompt });
        return Effect.succeed({ workType: " feature ", stage: "" });
      }) as TextGenerationOperations.Runner);

      const result = yield* generation.classifyThread({
        cwd: "/repo",
        message: "Add dark mode",
        workTypes,
        stages,
        includeWorkType: true,
        modelSelection,
      });

      assert.deepStrictEqual(result, { workType: "feature", stage: null });
      assert.equal(requests[0]?.operation, "classifyThread");
      assert.isTrue(requests[0]?.prompt.includes("Add dark mode"));
      assert.isTrue(requests[0]?.prompt.includes("- building (Building)"));
    }),
  );
});
