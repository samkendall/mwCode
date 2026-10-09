import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RepositoryIdentity,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadHarnessReactor from "./ThreadHarnessReactor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:thread-harness");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in thread harness tests"),
} as ProviderAdapterV2Shape;

type ClassifyThread = TextGeneration.TextGeneration["Service"]["classifyThread"];

function makeHarness(
  options: {
    readonly classify?: ClassifyThread;
    readonly repositoryIdentity?: RepositoryIdentity | null;
  } = {},
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-harness" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerThreadManagement = ThreadManagement.layer.pipe(Layer.provide(layerOrchestrator));
  const classifyThread = vi.fn<ClassifyThread>(
    options.classify ?? (() => Effect.succeed({ workType: "bug", stage: "research" })),
  );
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requested) =>
      Effect.succeed(
        requested === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo-that-does-not-exist",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const layerReactor = ThreadHarnessReactor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerOrchestrator,
        layerThreadManagement,
        layerProjects,
        Layer.mock(TextGeneration.TextGeneration)({ classifyThread }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(options.repositoryIdentity ?? null),
        }),
        ServerSettings.layerTest({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-harness-" }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer: Layer.mergeAll(layerThreadManagement, layerReactor), classifyThread };
}

const createThread = (name: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:${name}:create`),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const sendMessage = (threadId: ThreadId, key: string, text: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:${threadId}:${key}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${key}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const setClassification = (
  threadId: ThreadId,
  key: string,
  fields: { workType?: string | null; stage?: string | null; stageManual?: boolean | null },
) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`command:${threadId}:${key}`),
      threadId,
      ...fields,
    });
  });

const readThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return (yield* threads.getThreadRecords(threadId, [])).thread;
  });

describe("ThreadHarnessReactor.classify", () => {
  it.effect("fills work type and stage from the model on the first message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("first");
      yield* sendMessage(threadId, "one", "The login button throws on click");
      yield* reactor.classify(threadId);

      const thread = yield* readThread(threadId);
      assert.equal(thread.workType, "bug");
      assert.equal(thread.stage, "research");
      const call = harness.classifyThread.mock.calls[0]?.[0];
      assert.equal(call?.message, "The login button throws on click");
      assert.isTrue(call?.includeWorkType);
      // The shell carries the classification to the sidebar.
      const threads = yield* ThreadManagement.ThreadManagementService;
      const shell = yield* threads.getThreadShell(threadId);
      assert.equal(shell?.workType, "bug");
      assert.equal(shell?.stage, "research");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("lets an explicit work type in the prompt beat the model", () => {
    const harness = makeHarness({
      classify: () => Effect.succeed({ workType: "bug", stage: "planning" }),
    });
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("explicit");
      yield* sendMessage(threadId, "one", "/momo feature add dark mode");
      yield* reactor.classify(threadId);

      const thread = yield* readThread(threadId);
      assert.equal(thread.workType, "feature");
      assert.equal(thread.stage, "planning");
      assert.isFalse(harness.classifyThread.mock.calls[0]?.[0].includeWorkType);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("drops ids the taxonomy does not know", () => {
    const harness = makeHarness({
      classify: () => Effect.succeed({ workType: "made-up", stage: "building" }),
    });
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("unknown-id");
      yield* sendMessage(threadId, "one", "Do the thing");
      yield* reactor.classify(threadId);

      const thread = yield* readThread(threadId);
      assert.isTrue(thread.workType == null);
      assert.equal(thread.stage, "building");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a value the user set while the model was deciding", () => {
    let setDuringCall: Effect.Effect<void> = Effect.void;
    const harness = makeHarness({
      classify: () =>
        Effect.suspend(() => setDuringCall).pipe(Effect.as({ workType: "bug", stage: "research" })),
    });
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("race");
      yield* sendMessage(threadId, "one", "Something vague");
      const context = yield* Effect.context<ThreadManagement.ThreadManagementService>();
      setDuringCall = setClassification(threadId, "manual", { workType: "security" }).pipe(
        Effect.provide(context),
        Effect.orDie,
      );
      yield* reactor.classify(threadId);

      const thread = yield* readThread(threadId);
      assert.equal(thread.workType, "security");
      assert.equal(thread.stage, "research");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("re-assesses only the stage on later messages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("reassess");
      yield* sendMessage(threadId, "one", "The login button throws on click");
      yield* reactor.classify(threadId);

      harness.classifyThread.mockReturnValue(
        Effect.succeed({ workType: "feature", stage: "building" }),
      );
      yield* sendMessage(threadId, "two", "Looks right, go fix it");
      yield* reactor.classify(threadId);

      const thread = yield* readThread(threadId);
      assert.equal(thread.workType, "bug");
      assert.equal(thread.stage, "building");
      const call = harness.classifyThread.mock.calls.at(-1)?.[0];
      assert.isFalse(call?.includeWorkType);
      assert.deepEqual(call?.workTypes, []);
      assert.isTrue(call?.message.includes("Looks right, go fix it"));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves a stage the user pinned and skips the model", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("pinned");
      yield* sendMessage(threadId, "one", "The login button throws on click");
      yield* setClassification(threadId, "pin", {
        workType: "bug",
        stage: "planning",
        stageManual: true,
      });
      yield* sendMessage(threadId, "two", "Carry on");
      yield* reactor.classify(threadId);

      assert.equal(harness.classifyThread.mock.calls.length, 0);
      assert.equal((yield* readThread(threadId)).stage, "planning");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stops asking once a classified thread reaches the last stage", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("terminal");
      yield* sendMessage(threadId, "one", "The login button throws on click");
      yield* setClassification(threadId, "set", { workType: "bug", stage: "tweaking" });
      yield* sendMessage(threadId, "two", "One more nit");
      yield* reactor.classify(threadId);

      assert.equal(harness.classifyThread.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips a /compact turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("compact");
      yield* sendMessage(threadId, "one", "The login button throws on click");
      yield* sendMessage(threadId, "two", "/compact");
      yield* reactor.classify(threadId);

      assert.equal(harness.classifyThread.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("swallows a provider failure", () => {
    const harness = makeHarness({
      classify: () =>
        Effect.fail(new TextGenerationError({ operation: "classifyThread", detail: "boom" })),
    });
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("failure");
      yield* sendMessage(threadId, "one", "Something vague");
      yield* reactor.classify(threadId);

      const thread = yield* readThread(threadId);
      assert.isTrue(thread.workType == null);
      assert.isTrue(thread.stage == null);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("ThreadHarnessReactor.linkPullRequestFromRun", () => {
  const prUrl = "https://github.com/samkendall/mwCode/pull/42";
  const latestRunId = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs.at(-1);
      assert.isDefined(run);
      return run!.id;
    });
  const identity = (owner: string, name: string): RepositoryIdentity => ({
    canonicalKey: `github.com/${owner}/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `git@github.com:${owner}/${name}.git`,
    },
    provider: "github",
    owner,
    name,
  });

  it.effect("links the pull request a run named, as the agent's", () => {
    const harness = makeHarness({ repositoryIdentity: identity("SamKendall", "mwCode") });
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("link");
      yield* sendMessage(threadId, "one", `Please review ${prUrl} when you can`);
      yield* reactor.linkPullRequestFromRun(threadId, yield* latestRunId(threadId));

      const links = (yield* readThread(threadId)).pullRequests ?? [];
      assert.equal(links.length, 1);
      assert.equal(links[0]?.number, 42);
      assert.equal(links[0]?.source, "agent");
      assert.equal(links[0]?.repository.toLowerCase(), "samkendall/mwcode");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("ignores a pull request from another repository", () => {
    const harness = makeHarness({ repositoryIdentity: identity("pingdotgg", "t3code") });
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threadId = yield* createThread("other-repo");
      yield* sendMessage(threadId, "one", `Compare with ${prUrl}`);
      yield* reactor.linkPullRequestFromRun(threadId, yield* latestRunId(threadId));

      assert.deepEqual((yield* readThread(threadId)).pullRequests ?? [], []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves a thread that already has a link", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const reactor = yield* ThreadHarnessReactor.ThreadHarnessReactor;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const threadId = yield* createThread("already-linked");
      yield* threads.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("command:already-linked:manual"),
        threadId,
        host: "github.com",
        repository: "samkendall/mwCode",
        number: 7,
        url: "https://github.com/samkendall/mwCode/pull/7",
        source: "manual",
      });
      yield* sendMessage(threadId, "one", `Also see ${prUrl}`);
      yield* reactor.linkPullRequestFromRun(threadId, yield* latestRunId(threadId));

      const links = (yield* readThread(threadId)).pullRequests ?? [];
      assert.deepEqual(
        links.map((link) => link.number),
        [7],
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("pullRequestScanText", () => {
  const base = {
    threadId: ThreadId.make("thread:scan"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
  } as const;
  const item = (fields: Record<string, unknown>) =>
    ({ ...base, ...fields }) as unknown as OrchestrationV2TurnItem;

  it("reads command and tool output in timeline order", () => {
    const text = ThreadHarnessReactor.pullRequestScanText([
      item({ type: "assistant_message", ordinal: 3, text: "Opened it." }),
      item({
        type: "command_execution",
        ordinal: 2,
        input: "gh pr create --fill",
        output: "https://github.com/acme/app/pull/9\n",
      }),
      item({
        type: "dynamic_tool",
        ordinal: 1,
        output: { url: "https://github.com/acme/app/pull/3" },
      }),
      item({ type: "reasoning", ordinal: 0, text: "https://github.com/acme/app/pull/1" }),
    ]);
    assert.isFalse(text.includes("/pull/1"));
    assert.isTrue(text.indexOf("/pull/3") < text.indexOf("/pull/9"));
    assert.isTrue(text.indexOf("/pull/9") < text.indexOf("Opened it."));
  });
});
