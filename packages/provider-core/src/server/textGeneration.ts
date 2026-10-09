import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

/** One allowed taxonomy option (work type or stage) passed to the classifier. */
export interface ThreadClassificationOption {
  id: string;
  label: string;
  /** Optional one-line hint describing when the option applies. */
  description?: string | null | undefined;
}

export interface ThreadClassificationInput {
  cwd: string;
  /** The thread's first user message, or recent conversation when re-assessing. */
  message: string;
  /** Allowed work-type options; empty disables work-type classification. */
  workTypes: ReadonlyArray<ThreadClassificationOption>;
  /** Allowed stage options; empty disables stage classification. */
  stages: ReadonlyArray<ThreadClassificationOption>;
  /**
   * When false the caller already resolved the work type cheaply, so the model
   * only needs to choose a stage. The work type is still described for context.
   */
  includeWorkType: boolean;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadClassificationResult {
  /** A taxonomy work-type id, or null when the model declined. Unvalidated. */
  workType: string | null;
  /** A taxonomy stage id, or null when the model declined. Unvalidated. */
  stage: string | null;
}

/** Commit, change request, branch, and title generation backed by one provider instance. */
export interface ProviderTextGeneration {
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate change request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /** Generate a concise thread title from a first message or thread history. */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Fork-local: pick a harness work type and stage for a thread. Returned ids
   * are unvalidated; the caller checks them against the taxonomy.
   */
  readonly classifyThread: (
    input: ThreadClassificationInput,
  ) => Effect.Effect<ThreadClassificationResult, TextGenerationError>;
}
