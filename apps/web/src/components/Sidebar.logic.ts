import * as React from "react";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import type { ContextMenuItem } from "@t3tools/contracts";
import type {
  SidebarProjectSortOrder,
  SidebarSortBy,
  SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import {
  activeThreadAnchorTimestampMs,
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import type { ThreadRouteTarget } from "../threadRoutes";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription. Each prewarmed
// thread holds a live, fully hydrated detail subscription (all messages and
// activities, growing as agents work) for as long as the row stays visible,
// so this limit is a direct renderer-heap and server-load multiplier — keep
// it small; cold opens still render instantly from the cached snapshot.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 3;

// The list already reaches its destination through sortable transforms while
// the pointer is down. dnd-kit's default also animates the committed DOM order
// after release, replaying the same movement across every affected row.
export const animatePinnedLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
}): Promise<{
  archivedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    let didArchive = false;
    const result = await input.archive(entry, () => {
      didArchive = true;
    });
    if (didArchive || result._tag === "Success") {
      archivedThreadKeys.push(entry.threadKey);
    }
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, mutationFailure: null, followupFailures };
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Monitoring"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

// Rollup order mirrors the per-thread resolver exactly: attention states,
// then active work, then the actionable plan prompt, then passive
// monitoring. A Monitoring sibling must never hide a Plan Ready thread.
const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 6,
  "Awaiting Input": 5,
  Working: 4,
  Connecting: 4,
  "Plan Ready": 3,
  Monitoring: 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

// A double-click dispatches two `click` events before `dblclick`: the first has
// `detail === 1`, the second `detail === 2`. The second click must not run the
// row's single-click navigation, otherwise double-click-to-rename would also
// navigate. `MouseEvent.detail` is 0 for synthetic/keyboard activations, which
// still count as a normal single activation.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

/** Clicks on a nested link keep the link's meaning. The row must not treat them as multi-select. */
export function isSidebarNestedLinkClick(target: EventTarget | null): boolean {
  if (target == null || typeof target !== "object") return false;
  if (nodeClosest(target, "a[href]") !== null) return true;
  const parent =
    "parentElement" in target &&
    target.parentElement !== null &&
    typeof target.parentElement === "object"
      ? target.parentElement
      : null;
  return nodeClosest(parent, "a[href]") !== null;
}

// Shift+click on the new thread button creates directly in the current
// project, skipping the command palette's project picker. With a single
// project there is nothing to pick, so a plain click already creates
// immediately and the modifier changes nothing.
export function shouldCreateNewThreadInCurrentProject(
  shiftKey: boolean,
  projectGroupCount: number,
): boolean {
  return shiftKey || projectGroupCount <= 1;
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  getPreferenceIds?: (item: TItem) => readonly TId[];
}): TItem[] {
  const { getId, getPreferenceIds, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const indexesByPreferenceId = new Map<TId, number[]>();
  for (const [index, item] of items.entries()) {
    const preferenceIds = getPreferenceIds?.(item) ?? [getId(item)];
    for (const preferenceId of new Set(preferenceIds)) {
      const indexes = indexesByPreferenceId.get(preferenceId);
      if (indexes) {
        indexes.push(index);
      } else {
        indexesByPreferenceId.set(preferenceId, [index]);
      }
    }
  }

  const emittedIndexes = new Set<number>();
  const ordered = preferredIds.flatMap((id) => {
    const index = indexesByPreferenceId
      .get(id)
      ?.find((candidate) => !emittedIndexes.has(candidate));
    if (index === undefined) {
      return [];
    }
    emittedIndexes.add(index);
    return [items[index]!];
  });
  const remaining = items.filter((_, index) => !emittedIndexes.has(index));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function shouldNavigateAfterProjectRemoval(input: {
  routeTarget: ThreadRouteTarget | null;
  projectThreads: readonly {
    environmentId: string;
    id: string;
  }[];
  projectDraftId: string | null;
}): boolean {
  const { projectDraftId, projectThreads, routeTarget } = input;
  if (routeTarget?.kind === "draft") {
    return projectDraftId === routeTarget.draftId;
  }
  if (routeTarget?.kind !== "server") {
    return false;
  }
  return projectThreads.some(
    (thread) =>
      thread.environmentId === routeTarget.threadRef.environmentId &&
      thread.id === routeTarget.threadRef.threadId,
  );
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md px-2 text-left text-sm select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-sidebar-row-active text-sidebar-foreground font-medium hover:bg-sidebar-row-active hover:text-sidebar-foreground",
    );
  }

  return cn(
    baseClassName,
    "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
  );
}

// ── Sidebar thread status model ─────────────────────────────────────
// Five visual states, three colors: color is reserved for "act now"
// (approval), "in motion" (working), and "broken" (failed). Ready is the
// unlabeled resting state — the agent stopped and is waiting on the user,
// whether it finished, asked a question, or proposed a plan.
// Unread completion is tracked separately: it describes whether a ready
// thread needs attention, not what the thread is currently doing.
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "failed"
  | "ready";

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  // A failed session outranks lingering background liveness: the user must
  // see the failure, not a stale Working (review finding).
  if (thread.session?.status === "error") {
    return "failed";
  }
  // Background work outlives the turn: fleets read as working; monitoring
  // only when watch loops are the sole live work.
  if (thread.backgroundLiveness === "working") {
    return "working";
  }
  if (thread.backgroundLiveness === "monitoring") {
    return "monitoring";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
export function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** First VALID timestamp wins: `a ?? b` falls through on null, but a present-
    yet-malformed string must also fall through to the next candidate rather
    than sink the row to the epoch. */
export function firstValidTimestampMs(
  ...candidates: ReadonlyArray<string | null | undefined>
): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** String twin of firstValidTimestampMs for callers that need the ISO string
    (display labels, tick anchors) rather than epoch ms. */
export function firstValidTimestamp(
  ...candidates: ReadonlyArray<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

// Sidebar sort: static order, newest anchor on top. Activity NEVER reorders
// the list — a row holds its position between lifecycle transitions, so the
// screen only moves when a thread enters or leaves the active list. The
// anchor is creation time until an un-settle re-anchors it (see
// activeThreadAnchorTimestampMs), so an un-settled thread surfaces at the
// top instead of sinking back to its creation-order slot. Status (including
// pending approval) is carried by each card's edge strip, not by position.
export function sortThreadsForSidebar<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  },
>(threads: readonly T[]): T[] {
  return [...threads].toSorted(
    (left, right) =>
      activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left) ||
      left.id.localeCompare(right.id),
  );
}

// Optional signal fields the active-section sort reads. Every field already
// lives on the thread shell, so no mode adds a subscription or poll.
type ActiveSortInput = {
  readonly id: string;
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
  readonly workType?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly linkedPullRequest?: { readonly number: number } | null | undefined;
};

/**
 * Reorders the ACTIVE sidebar section by an explicit sort preference. "default"
 * is byte-identical to the intentionally static order (sortThreadsForSidebar):
 * rows never reshuffle as activity changes. Every other mode buckets threads
 * into a coarse tier (attention needed, work-type cluster, has-PR) and falls
 * back to the SAME static comparator inside each tier, so a re-sort can only
 * move a row between tiers — never jitter within one. Keys read straight off
 * the thread shell, so no mode adds a subscription. When grouping is on, the
 * caller sorts before grouping so this order becomes the within-group order.
 */
export function sortActiveThreadsForSidebar<T extends ActiveSortInput>(
  threads: readonly T[],
  sortBy: SidebarSortBy,
  taxonomy: readonly TaxonomyEntryLike[],
): T[] {
  if (sortBy === "default") return sortThreadsForSidebar(threads);

  const staticCompare = (left: T, right: T) =>
    activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left) ||
    left.id.localeCompare(right.id);

  const rankOf = (thread: T): number => {
    switch (sortBy) {
      case "needs-input":
        return thread.hasPendingApprovals === true || thread.hasPendingUserInput === true ? 0 : 1;
      case "work-type": {
        const raw = thread.workType;
        const trimmed = raw == null ? "" : raw.trim();
        // Unset and orphaned ids both sink below every known taxonomy entry.
        if (trimmed.length === 0) return taxonomy.length;
        const index = taxonomy.findIndex((entry) => entry.id === trimmed);
        return index === -1 ? taxonomy.length : index;
      }
      case "pr":
        return thread.linkedPullRequest != null ? 0 : 1;
    }
  };

  return [...threads].toSorted(
    (left, right) => rankOf(left) - rankOf(right) || staticCompare(left, right),
  );
}

/**
 * Orders logical project groups for the group-by-project sidebar mode by an
 * explicit, persisted manual order — NOT by activity, so a group never jumps
 * as its threads work. Projects listed in `manualOrder` come first, in that
 * order; every project the list doesn't mention sorts AFTER them in a stable,
 * activity-independent order (alphabetical by display name, projectKey
 * tiebreak) so a brand-new project lands deterministically instead of leaping
 * to the top. An empty manual order therefore renders the whole set
 * alphabetically.
 */
export function orderProjectGroupsByManualOrder<
  TProject extends { readonly projectKey: string; readonly displayName: string },
>(projects: readonly TProject[], manualOrder: readonly string[]): TProject[] {
  const orderIndex = new Map(manualOrder.map((key, index) => [key, index] as const));
  return [...projects].toSorted((left, right) => {
    const leftIndex = orderIndex.get(left.projectKey);
    const rightIndex = orderIndex.get(right.projectKey);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return (
      left.displayName.localeCompare(right.displayName) ||
      left.projectKey.localeCompare(right.projectKey)
    );
  });
}

/** Moves `activeKey` to `overKey`'s slot within the on-screen key order,
    mirroring dnd-kit's arrayMove. Returns a fresh list; a no-op (key missing or
    already in place) returns a copy of the input so the caller can persist it
    unconditionally (seeding the manual order from the current order). */
export function reorderProjectKeys(
  orderedKeys: readonly string[],
  activeKey: string,
  overKey: string,
): string[] {
  const next = [...orderedKeys];
  const fromIndex = next.indexOf(activeKey);
  const toIndex = next.indexOf(overKey);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return next;
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

// The active-section thread sort modes, in menu order, with their labels.
// Shared by the Settings → General default-sort select and the per-project
// sort menu in each grouped-by-project header so the two never drift.
export const SIDEBAR_SORT_BY_LABELS: Record<SidebarSortBy, string> = {
  default: "Default",
  "needs-input": "Needs my attention",
  "work-type": "Work type",
  pr: "Has a PR",
};
export const SIDEBAR_SORT_BY_OPTIONS: ReadonlyArray<SidebarSortBy> = [
  "default",
  "needs-input",
  "work-type",
  "pr",
];

/** A project group's effective thread sort: its per-project override when set,
    otherwise the global default. Used to sort threads within each group when
    the sidebar groups the active section by project. */
export function resolveProjectEffectiveSort(
  projectKey: string,
  overrides: Readonly<Record<string, SidebarSortBy>>,
  globalSortBy: SidebarSortBy,
): SidebarSortBy {
  return overrides[projectKey] ?? globalSortBy;
}

/** Bucket key for threads whose project isn't in the logical project list
    (an environment that dropped offline mid-render, a project removed while
    its threads are still streaming). The rows stay reachable instead of
    disappearing from the list. */
export const SIDEBAR_UNGROUPED_THREADS_KEY = "__ungrouped__";

export interface SidebarThreadGroup<TProject, TThread> {
  readonly key: string;
  /** null for the trailing catch-all group. */
  readonly project: TProject | null;
  readonly threads: readonly TThread[];
}

/**
 * Groups already-ordered active threads under their logical project, for the
 * sidebar's "group by project" mode. Both orders come from the caller and are
 * preserved verbatim: `projects` decides group order (sortLogicalProjectsForSidebar)
 * and the thread order within each group is the input order
 * (sortThreadsForSidebar's static anchor ordering). Empty groups are dropped,
 * so a project only appears while it has visible work. Reading the result with
 * flatMap gives the flat visual order the keyboard navigation indexes by.
 */
export function buildSidebarThreadGroups<
  TProject extends {
    readonly projectKey: string;
    readonly memberProjectRefs: readonly {
      readonly environmentId: string;
      readonly projectId: string;
    }[];
  },
  TThread extends { readonly environmentId: string; readonly projectId: string },
>(input: {
  projects: readonly TProject[];
  threads: readonly TThread[];
}): SidebarThreadGroup<TProject, TThread>[] {
  const projectKeyByRef = new Map<string, string>();
  for (const project of input.projects) {
    for (const projectRef of project.memberProjectRefs) {
      projectKeyByRef.set(
        `${projectRef.environmentId}\0${projectRef.projectId}`,
        project.projectKey,
      );
    }
  }
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of input.threads) {
    const projectKey =
      projectKeyByRef.get(`${thread.environmentId}\0${thread.projectId}`) ??
      SIDEBAR_UNGROUPED_THREADS_KEY;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }
  const groups: SidebarThreadGroup<TProject, TThread>[] = [];
  for (const project of input.projects) {
    const threads = threadsByProjectKey.get(project.projectKey);
    if (threads === undefined) continue;
    groups.push({ key: project.projectKey, project, threads });
  }
  const ungrouped = threadsByProjectKey.get(SIDEBAR_UNGROUPED_THREADS_KEY);
  if (ungrouped !== undefined) {
    groups.push({ key: SIDEBAR_UNGROUPED_THREADS_KEY, project: null, threads: ungrouped });
  }
  return groups;
}

// Bucket key for active threads whose workType/stage is null, empty, or
// whitespace-only when grouping the active section by a classification
// dimension. Always sorts last, after every taxonomy and unknown-id group.
export const SIDEBAR_UNCLASSIFIED_GROUP_KEY = "__unclassified__";

/** One resolved classification chip: the taxonomy entry's label/color for a
    known id, or the raw id (muted, no color) for an id the taxonomy no longer
    lists. Null/empty values resolve to no badge at all. */
export interface ClassificationBadgeModel {
  readonly id: string;
  readonly label: string;
  readonly color: string | null;
  /** False when the id is not in the taxonomy — render it muted as a raw id. */
  readonly known: boolean;
}

type TaxonomyEntryLike = {
  readonly id: string;
  readonly label: string;
  readonly color?: string | null | undefined;
};

/** Maps a thread's stored workType/stage id to its display chip. A present-but-
    orphaned id (taxonomy renamed/removed it) still renders, as its raw id with
    no color, so the thread never silently loses its classification. */
export function resolveClassificationBadge(
  entries: readonly TaxonomyEntryLike[],
  value: string | null | undefined,
): ClassificationBadgeModel | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const entry = entries.find((candidate) => candidate.id === trimmed);
  if (entry) {
    return { id: trimmed, label: entry.label, color: entry.color ?? null, known: true };
  }
  return { id: trimmed, label: trimmed, color: null, known: false };
}

/**
 * The stage pipeline's fill boundary: the index of the thread's current stage
 * within the taxonomy's `stages` order, so every dot at or before it renders
 * filled and every dot after it renders hollow. Returns -1 when the thread has
 * no stage, or carries one the taxonomy no longer lists — an all-hollow
 * pipeline, since an orphaned id has no position in the current lifecycle.
 * Trims like resolveClassificationBadge so a padded stored value still matches.
 */
export function resolveStageFillIndex(
  stages: readonly TaxonomyEntryLike[],
  value: string | null | undefined,
): number {
  if (value == null) return -1;
  const trimmed = value.trim();
  if (trimmed.length === 0) return -1;
  return stages.findIndex((entry) => entry.id === trimmed);
}

/**
 * Whether a thread's branch is the repo's default and so not worth surfacing in
 * the row (the row already de-dupes identity that reads elsewhere). Prefers a
 * trustworthy live signal — `isDefaultRef`, passed only when the checked-out
 * ref is actually this thread's branch — and otherwise falls back to the
 * near-universal default-branch names. An empty/absent branch is not a default
 * branch (there is simply nothing to show); the caller's own presence check
 * handles that case.
 */
export function isDefaultThreadBranch(
  branch: string | null | undefined,
  isDefaultRef?: boolean | null | undefined,
): boolean {
  const trimmed = branch?.trim();
  if (!trimmed) return false;
  if (isDefaultRef === true) return true;
  const lower = trimmed.toLowerCase();
  return lower === "main" || lower === "master";
}

export interface SidebarTaxonomyThreadGroup<TThread> {
  /** Taxonomy id, raw unknown id, or SIDEBAR_UNCLASSIFIED_GROUP_KEY. */
  readonly key: string;
  /** Header text: taxonomy label, raw id, or the unclassified label. */
  readonly label: string;
  /** Taxonomy color for a known id; null for unknown ids and the catch-all. */
  readonly color: string | null;
  /** False for unknown-id and unclassified groups so the header can mute them. */
  readonly known: boolean;
  readonly threads: readonly TThread[];
}

/**
 * Groups already-ordered active threads by a classification dimension
 * (`workType` or `stage`) for the sidebar's group-by-workType/stage modes.
 * Group order is: every taxonomy entry that has threads, in taxonomy order;
 * then ids the taxonomy no longer lists, in first-appearance order; then a
 * single trailing "Unclassified" bucket for null/empty values. Thread order
 * within each group is the caller's input order (sortThreadsForSidebar's
 * static anchor ordering), so reading the result with flatMap yields the flat
 * visual order keyboard navigation indexes by.
 */
export function buildSidebarThreadGroupsByTaxonomy<TThread>(input: {
  taxonomy: readonly TaxonomyEntryLike[];
  threads: readonly TThread[];
  getValue: (thread: TThread) => string | null | undefined;
  unclassifiedLabel: string;
}): SidebarTaxonomyThreadGroup<TThread>[] {
  const entryById = new Map(input.taxonomy.map((entry) => [entry.id, entry]));
  // Insertion order = first-appearance order, which decides unknown-id groups.
  const threadsByKey = new Map<string, TThread[]>();
  for (const thread of input.threads) {
    const raw = input.getValue(thread);
    const trimmed = raw == null ? "" : raw.trim();
    const key = trimmed.length === 0 ? SIDEBAR_UNCLASSIFIED_GROUP_KEY : trimmed;
    const existing = threadsByKey.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByKey.set(key, [thread]);
    }
  }

  const groups: SidebarTaxonomyThreadGroup<TThread>[] = [];
  // Known taxonomy entries first, in taxonomy order.
  for (const entry of input.taxonomy) {
    const threads = threadsByKey.get(entry.id);
    if (threads === undefined) continue;
    groups.push({
      key: entry.id,
      label: entry.label,
      color: entry.color ?? null,
      known: true,
      threads,
    });
  }
  // Unknown ids next, in first-appearance order.
  for (const [key, threads] of threadsByKey) {
    if (key === SIDEBAR_UNCLASSIFIED_GROUP_KEY) continue;
    if (entryById.has(key)) continue;
    groups.push({ key, label: key, color: null, known: false, threads });
  }
  // Unclassified always last.
  const unclassified = threadsByKey.get(SIDEBAR_UNCLASSIFIED_GROUP_KEY);
  if (unclassified !== undefined) {
    groups.push({
      key: SIDEBAR_UNCLASSIFIED_GROUP_KEY,
      label: input.unclassifiedLabel,
      color: null,
      known: false,
      threads: unclassified,
    });
  }
  return groups;
}

// Pinned-reorder key math and the keyed sort live in client-runtime
// (state/thread-sort) so web and mobile compute identical pinned orders.
export {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedReorder,
} from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

/**
 * Search the already-ordered sidebar thread collection by title only.
 * Keeping the input order means lifecycle ordering (active, snoozed, settled)
 * remains stable while the user narrows the list.
 */
export function searchSidebarThreadsByTitle<T extends { readonly title: string }>(
  threads: readonly T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return [];
  return threads.filter((thread) => thread.title.toLowerCase().includes(normalizedQuery));
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  activeScopeKey: string | null;
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const projectItems = input.items.filter((item) => item.value !== "all");
  const query = input.query.trim();
  if (query.length > 0) {
    return projectItems.filter((item) => input.matches(item, query));
  }
  return input.activeScopeKey === null ? projectItems : input.items;
}

export interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

export type SidebarProjectScopeMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceSidebarProjectScopeMenuState(
  state: SidebarProjectScopeMenuState,
  action: SidebarProjectScopeMenuAction,
): SidebarProjectScopeMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}

type SettledTimestampInput = Pick<
  SidebarThreadSummary,
  "settledAt" | "latestUserMessageAt" | "latestTurn" | "updatedAt"
>;

/** The timestamp a settled row sorts and labels by: settledAt when stamped
    (explicit settles), otherwise last activity — the same candidates
    threadLastActivityAt feeds the auto-settle window (user message plus all
    latestTurn stamps), so a thread whose last activity was a turn completion
    doesn't sort by an older message time. updatedAt is the final net. */
export function resolveSettledTimestamp(thread: SettledTimestampInput): string | null {
  const settledAt = firstValidTimestamp(thread.settledAt);
  if (settledAt !== null) return settledAt;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed) && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  return latest ?? firstValidTimestamp(thread.updatedAt);
}

// Settled rows are history, so they order by when the work ENDED, not when
// the thread was created or last touched.
export function sortSettledThreadsForSidebar<
  T extends SettledTimestampInput & { readonly id: string },
>(threads: readonly T[]): T[] {
  const timestampMs = (thread: T) => {
    const timestamp = resolveSettledTimestamp(thread);
    return timestamp === null ? 0 : Date.parse(timestamp);
  };
  return [...threads].toSorted(
    (left, right) => timestampMs(right) - timestampMs(left) || left.id.localeCompare(right.id),
  );
}

/** The timestamp a working thread's elapsed label counts from: the running
    turn's start (request time until adoption), falling back to the session's
    last transition when the turn projection lags behind. Malformed
    timestamps fall through to the next candidate, not just missing ones. */
export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestTurn" | "session">,
): string | null {
  const turn = thread.latestTurn;
  if (turn && turn.completedAt === null) {
    return firstValidTimestamp(turn.startedAt, turn.requestedAt, thread.session?.updatedAt);
  }
  return firstValidTimestamp(thread.session?.updatedAt);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Which source owns a thread row's line-1 status slot. Live turn work (working,
// monitoring, approval, input, failed, freshly-woke) always wins so in-flight
// work is never hidden; a linked PR's review/merge state comes next, promoting
// "Awaiting review" / "Ready to merge" / "Merged" over a bare "Done"; the
// unread-completion "Done" is last, and "none" leaves the relative time.
export type TopLineStatusSource = "live" | "pr" | "done" | "none";

export function resolveTopLineStatusSource(input: {
  hasLiveStatus: boolean;
  hasPrReviewStatus: boolean;
  hasUnreadCompletion: boolean;
}): TopLineStatusSource {
  if (input.hasLiveStatus) return "live";
  if (input.hasPrReviewStatus) return "pr";
  if (input.hasUnreadCompletion) return "done";
  return "none";
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "starting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  // An actionable plan prompt outranks lingering background work: it needs
  // the user's decision, while liveness merely reports (review finding).
  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  // The turn can settle while native background work runs on. Subagent and
  // workflow fleets read as plain Working; Monitoring is reserved for watch
  // loops (a parent agent babysitting a PR, tailing checks) with no other
  // live work. Same recede treatment as Working per inbox-zero.
  if (thread.backgroundLiveness === "working") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.backgroundLiveness === "monitoring") {
    return {
      label: "Monitoring",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function sortProjectsByActivity<TProject extends SidebarProject>(
  projects: readonly TProject[],
  sortOrder: SidebarProjectSortOrder,
  getProjectThreads: (project: TProject) => readonly ThreadSortInput[],
  compareTies: (left: TProject, right: TProject) => number,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(right, getProjectThreads(right), sortOrder);
    const leftTimestamp = getProjectSortTimestamp(left, getProjectThreads(left), sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    return byTimestamp || compareTies(left, right);
  });
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectId.get(project.id) ?? [],
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}

export function sortLogicalProjectsForSidebar<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const groupKeyByProjectRef = new Map(
    projects.flatMap((project) =>
      project.memberProjectRefs.map(
        (projectRef) =>
          [`${projectRef.environmentId}\0${projectRef.projectId}`, project.projectKey] as const,
      ),
    ),
  );
  const threadsByProjectKey = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const existing = threadsByProjectKey.get(projectKey);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProjectKey.get(project.projectKey) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) || left.projectKey.localeCompare(right.projectKey),
  );
}

/**
 * Sorts the cross-environment project collection used by landing surfaces.
 * Project ids are only unique within an environment, and archived threads
 * must not make a project appear recently active.
 */
export function sortScopedProjectsForSidebar<
  TProject extends ScopedSidebarProject,
  TThread extends ScopedSidebarThread,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  const scopedKey = (environmentId: string, projectId: string) =>
    `${environmentId}\u0000${projectId}`;
  const threadsByProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    const key = scopedKey(thread.environmentId, thread.projectId);
    const existing = threadsByProject.get(key) ?? [];
    existing.push(thread);
    threadsByProject.set(key, existing);
  }

  return sortProjectsByActivity(
    projects,
    sortOrder,
    (project) => threadsByProject.get(scopedKey(project.environmentId, project.id)) ?? [],
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.id.localeCompare(right.id),
  );
}
