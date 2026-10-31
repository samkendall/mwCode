/**
 * Fork-local hybrid classification of a thread's harness `workType` and `stage`, requested
 * by the RPC layer after a user message lands. Best effort: failures are logged and swallowed.
 *
 * @module orchestration-v2/ThreadHarnessReactor
 */
import { CommandId, isProviderNativeSubagentThread, type ThreadId } from "@t3tools/contracts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { parseExplicitWorkType, resolveTaxonomyId } from "../harnessClassification.ts";
import { loadGlobalHarnessTaxonomy, resolveProjectHarnessTaxonomy } from "../harnessTaxonomy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadHarnessReactor extends Context.Service<
  ThreadHarnessReactor,
  {
    /**
     * Classifies the thread for the user message that just landed: the first
     * message fills `workType` and `stage`; later ones re-assess `stage`.
     */
    readonly classify: (threadId: ThreadId) => Effect.Effect<void>;
    /** Runs `classify` in the background so the caller's command is not held up. */
    readonly requestClassification: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadHarnessReactor") {}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto
      .randomUUIDv4()
      .pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)));

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
        isNativeMaintenanceCommand(latestUserMessage)
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

  return {
    classify,
    requestClassification,
  } satisfies ThreadHarnessReactor["Service"];
});

export const layer = Layer.effect(ThreadHarnessReactor, make);
