import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(input: {
  readonly workType?: string | null;
  readonly stage?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        workType: input.workType ?? null,
        stage: input.stage ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread classification decider", (it) => {
  it.effect("thread.meta.update sets workType and stage", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-set"),
          threadId: ThreadId.make("thread-1"),
          workType: "feature",
          stage: "in-review",
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.workType).toBe("feature");
        expect(events[0].payload.stage).toBe("in-review");
      }
    }),
  );

  it.effect("thread.meta.update clears each field with an explicit null", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-clear"),
          threadId: ThreadId.make("thread-1"),
          workType: null,
          stage: null,
        },
        readModel: makeReadModel({ workType: "feature", stage: "in-review" }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.workType).toBeNull();
        expect(events[0].payload.stage).toBeNull();
      }
    }),
  );

  it.effect("omitted fields stay absent so the projection leaves them unchanged", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-partial"),
          threadId: ThreadId.make("thread-1"),
          workType: "bug",
        },
        readModel: makeReadModel({ workType: "feature", stage: "in-review" }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.workType).toBe("bug");
        expect(events[0].payload.stage).toBeUndefined();
      }
    }),
  );
});
