import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const createdPayload = (extra: Record<string, unknown> = {}) => ({
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

it.effect("thread.created without classification leaves both fields null", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeEvent({ sequence: 1, type: "thread.created", payload: createdPayload() }),
    );
    expect(created.threads[0]?.workType ?? null).toBeNull();
    expect(created.threads[0]?.stage ?? null).toBeNull();
  }),
);

it.effect("projects classification through create, update, and clear", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: createdPayload({ workType: "feature", stage: "triage" }),
      }),
    );
    expect(created.threads[0]?.workType).toBe("feature");
    expect(created.threads[0]?.stage).toBe("triage");

    // A partial update touches only the field it carries.
    const advanced = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.meta-updated",
        payload: { threadId: ThreadId.make("thread-1"), stage: "in-review", updatedAt: NOW },
      }),
    );
    expect(advanced.threads[0]?.workType).toBe("feature");
    expect(advanced.threads[0]?.stage).toBe("in-review");

    // Explicit nulls clear; the sibling field survives untouched.
    const cleared = yield* projectEvent(
      advanced,
      makeEvent({
        sequence: 3,
        type: "thread.meta-updated",
        payload: { threadId: ThreadId.make("thread-1"), workType: null, updatedAt: NOW },
      }),
    );
    expect(cleared.threads[0]?.workType).toBeNull();
    expect(cleared.threads[0]?.stage).toBe("in-review");
  }),
);
