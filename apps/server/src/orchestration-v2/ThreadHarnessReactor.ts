/**
 * Fork-local thread upkeep that upstream has no equivalent for:
 *
 * - Hybrid classification of a thread's harness `workType` and `stage`, asked
 *   for by the RPC layer after a user message lands (the client's
 *   `autoClassifyThreads` setting is only known there).
 * - Linking a pull request the session surfaced on its own. Upstream links a
 *   PR only when the agent calls the MCP link tool or T3 Code creates it, so a
 *   `gh pr create` result line or a URL in a reply would otherwise go unlinked.
 *
 * Both are best effort: every failure is logged and swallowed so neither can
 * fail a command or a turn.
 *
 * @module orchestration-v2/ThreadHarnessReactor
 */
import {
  CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { parseExplicitWorkType, resolveTaxonomyId } from "../harnessClassification.ts";
import { loadGlobalHarnessTaxonomy, resolveProjectHarnessTaxonomy } from "../harnessTaxonomy.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { extractPullRequestReference, resolveLinkedRepository } from "../pullRequestReference.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const PULL_REQUEST_SCAN_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "command_execution",
  "dynamic_tool",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

/**
 * The text of a run's turn items to scan for a pull request URL, in timeline
 * order so the last URL the run named wins. Tool output is included because a
 * `gh pr create` result line is a command result, not message text, and agents
 * often do not repeat it in their reply.
 */
export function pullRequestScanText(turnItems: ReadonlyArray<OrchestrationV2TurnItem>): string {
  return turnItems
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .flatMap((item) => {
      switch (item.type) {
        case "user_message":
        case "assistant_message":
          return [item.text];
        case "command_execution":
          return [`${item.input}\n${item.output ?? ""}`];
        case "dynamic_tool":
          try {
            return [JSON.stringify(item.output) ?? ""];
          } catch {
            return [];
          }
        default:
          return [];
      }
    })
    .join("\n");
}

export class ThreadHarnessReactor extends Context.Service<
  ThreadHarnessReactor,
  {
    /** Links pull requests from runs as they end. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Classifies the thread for the user message that just landed: the first
     * message fills `workType` and `stage`; later ones re-assess `stage`.
     */
    readonly classify: (threadId: ThreadId) => Effect.Effect<void>;
    /** Runs `classify` in the background so the caller's command is not held up. */
    readonly requestClassification: (threadId: ThreadId) => Effect.Effect<void>;
    /** Links the pull request the given run named, unless the thread already has one. */
    readonly linkPullRequestFromRun: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadHarnessReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const failSoft =
    (message: string, threadId: ThreadId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(message, { threadId, cause: Cause.pretty(cause) }),
        ),
      );

  const classify: ThreadHarnessReactor["Service"]["classify"] = Effect.fn(
    "ThreadHarnessReactor.classify",
  )(function* (threadId) {
    yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user", "assistant"],
      });
      const thread = projection.thread;
      if (thread.deletedAt !== null || isProviderNativeSubagentThread(thread)) return;
      const messages = projection.messages.filter((message) => !message.streaming);
      const userMessages = messages.filter((message) => message.role === "user");
      const latestUserMessage = userMessages.at(-1);
      const firstUserMessage = userMessages[0];
      // A `/compact` or `/logout` turn carries no new intent to classify.
      if (
        latestUserMessage === undefined ||
        firstUserMessage === undefined ||
        Orchestrator.isNativeMaintenanceCommand(latestUserMessage)
      ) {
        return;
      }

      const project = Option.getOrUndefined(yield* projects.get(thread.projectId));
      const global = yield* loadGlobalHarnessTaxonomy(serverConfig.baseDir);
      const taxonomy =
        project === undefined
          ? global
          : yield* resolveProjectHarnessTaxonomy(project.workspaceRoot, global);

      // The first message fills whatever is unset. Later messages re-pick the
      // stage, unless the user pinned it, and fill a work type still missing.
      const firstTurn = userMessages.length === 1;
      if (!firstTurn && thread.stageManual === true) return;
      const needsWorkType = thread.workType == null && taxonomy.workTypes.length > 0;
      const needsStage = taxonomy.stages.length > 0 && (firstTurn ? thread.stage == null : true);
      if (!needsWorkType && !needsStage) return;
      // The last stage cannot advance, so a fully classified thread sitting on
      // it has nothing left to decide. This bounds the per-message model cost.
      if (!needsWorkType && !firstTurn && thread.stage === taxonomy.stages.at(-1)?.id) return;

      // An explicit work type in the first message beats the model.
      const parsedWorkType = needsWorkType
        ? parseExplicitWorkType(firstUserMessage.text, taxonomy)
        : null;
      const includeWorkType = needsWorkType && parsedWorkType === null;

      let generated: TextGeneration.ThreadClassificationResult = { workType: null, stage: null };
      if (includeWorkType || needsStage) {
        const context = firstTurn
          ? { message: firstUserMessage.text, attachments: firstUserMessage.attachments }
          : formatThreadTitleContext(messages);
        if (context.message.length === 0) return;
        const settings = resolveProjectSettings(
          yield* serverSettings.getSettings,
          thread.projectId,
        ).settings;
        generated = yield* textGeneration.classifyThread({
          cwd: thread.worktreePath ?? project?.workspaceRoot ?? serverConfig.cwd,
          message: context.message,
          workTypes: firstTurn || includeWorkType ? taxonomy.workTypes : [],
          stages: needsStage ? taxonomy.stages : [],
          includeWorkType,
          ...(context.attachments.length > 0 ? { attachments: context.attachments } : {}),
          modelSelection: settings.textGenerationModelSelection,
        });
      }

      // Ids are checked against the taxonomy so a hallucinated one is dropped.
      const resolvedWorkType = needsWorkType
        ? (parsedWorkType ?? resolveTaxonomyId(taxonomy.workTypes, generated.workType))
        : null;
      const resolvedStage = needsStage ? resolveTaxonomyId(taxonomy.stages, generated.stage) : null;
      if (resolvedWorkType === null && resolvedStage === null) return;

      // The model call takes seconds. Read again so a value the user set in
      // the meantime wins: work type is only ever filled, and a pinned stage
      // is left alone.
      const current = (yield* threads.getThreadRecords(threadId, [])).thread;
      const workType =
        resolvedWorkType !== null && current.workType == null ? resolvedWorkType : null;
      const stage =
        resolvedStage !== null &&
        current.stageManual !== true &&
        (firstTurn ? current.stage == null : current.stage !== resolvedStage)
          ? resolvedStage
          : null;
      if (workType === null && stage === null) return;

      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: yield* commandId("thread-classify", threadId),
        threadId,
        ...(workType === null ? {} : { workType }),
        ...(stage === null ? {} : { stage }),
      });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      failSoft("thread classification failed", threadId),
    );
  });

  const requestClassification: ThreadHarnessReactor["Service"]["requestClassification"] = (
    threadId,
  ) => classify(threadId).pipe(Effect.forkIn(scope), Effect.asVoid);

  const linkPullRequestFromRun: ThreadHarnessReactor["Service"]["linkPullRequestFromRun"] =
    Effect.fn("ThreadHarnessReactor.linkPullRequestFromRun")(function* (threadId, runId) {
      yield* Effect.gen(function* () {
        const projection = yield* threads.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: [runId],
          turnItemTypes: PULL_REQUEST_SCAN_ITEM_TYPES,
        });
        const thread = projection.thread;
        // Any existing link wins, whoever made it. A provider's own subagent
        // reports to its parent thread, which owns the pull request.
        if (
          thread.deletedAt !== null ||
          isProviderNativeSubagentThread(thread) ||
          visibleThreadPullRequests(thread.pullRequests ?? []).length > 0
        ) {
          return;
        }
        const detected = extractPullRequestReference(pullRequestScanText(projection.turnItems));
        if (detected === null) return;

        // A pull request from another repository pasted into the thread is not
        // the thread's own. An unknown project repository allows the link.
        const project = Option.getOrUndefined(yield* projects.get(thread.projectId));
        const identity =
          project === undefined
            ? null
            : yield* repositoryIdentities.resolve(thread.worktreePath ?? project.workspaceRoot);
        const repository = resolveLinkedRepository(
          detected.repository,
          sourceControlRepositorySelector(identity),
        );
        if (repository === null) return;

        const current = (yield* threads.getThreadRecords(threadId, [])).thread;
        if (visibleThreadPullRequests(current.pullRequests ?? []).length > 0) return;

        yield* threads.dispatch({
          type: "thread.pull-request.link",
          commandId: yield* commandId("thread-link-pull-request", threadId),
          threadId,
          host: detected.host,
          repository,
          number: detected.number,
          url: detected.url,
          source: "agent",
        });
      }).pipe(failSoft("thread pull request auto-link failed", threadId));
    });

  const start: ThreadHarnessReactor["Service"]["start"] = Effect.fn("ThreadHarnessReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "run.updated" &&
          ThreadManagementService.isTerminalRunStatus(event.payload.status)
            ? linkPullRequestFromRun(event.threadId, event.payload.id)
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("thread harness event stream failed", {
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      );
    },
  );

  return {
    start,
    classify,
    requestClassification,
    linkPullRequestFromRun,
  } satisfies ThreadHarnessReactor["Service"];
});

export const layer = Layer.effect(ThreadHarnessReactor, make);
