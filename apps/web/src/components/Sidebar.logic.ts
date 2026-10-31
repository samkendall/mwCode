import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveThreadWorkingStartedAt } from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import {
  threadSearchMatchKey,
  threadSearchSubject,
  type ThreadSearchShell,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import type { ContextMenuItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  SidebarGroupBy,
  SidebarProjectSortOrder,
  SidebarSortBy,
  SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import type { AsyncResult } from "effect/reactivity";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  planPinnedReorder,
  sortActiveThreadsByOrderKey,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSummary, Thread } from "../types";
import { normalizeSearchText } from "../lib/utils";
import { isLatestRunSettled } from "../session-logic";
import { observeIntersection } from "../lib/observeIntersection";
import { deadlineAfter, deadlineStore } from "@t3tools/client-runtime/clock";
import { useDeadlinePassed } from "../hooks/useDeadline";
import { legacyProjectCwdPreferenceKey } from "../uiStateStore";

export function shouldNavigateAfterThreadPark(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly action: "settle" | "snooze";
  readonly now: string;
  readonly thread: (ThreadSnoozeShell & Pick<SidebarThreadSummary, "settledOverride">) | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    (input.action === "settle"
      ? input.thread.settledOverride === "settled"
      : effectiveSnoozed(input.thread, { now: input.now }))
  );
}

const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Each prewarm retains growing thread detail and a live subscription, multiplying heap and server load.
const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: (row: HTMLElement | null) => (() => void) | undefined;
} {
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);
  if (isActive && !isNearViewport) setIsNearViewport(true);
  const canObserve = typeof IntersectionObserver !== "undefined";

  return {
    leaseLiveStatus: isActive || isNearViewport || !canObserve,
    rowRef: (row) => {
      if (row === null || isActive || !canObserve) return undefined;
      // The overscan has to apply to the sidebar's own scroller; a viewport-rooted
      // margin is still clipped by it.
      return observeIntersection(row, (entry) => setIsNearViewport(entry.isIntersecting), {
        root: row.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      });
    },
  };
}

const fileDragClears = new Set<(active: false) => void>();
function clearFileDrags() {
  const clears = [...fileDragClears];
  fileDragClears.clear();
  for (const clear of clears) clear(false);
}

/**
 * A file drag that ends outside every drop target (Escape, or a drop elsewhere)
 * sends no dragleave to the row it last entered, so the window's dragend clears it.
 */
export function setFileDragActive(setActive: (active: boolean) => void, active: boolean) {
  setActive(active);
  if (typeof window === "undefined") return;
  if (!active) {
    if (fileDragClears.delete(setActive) && fileDragClears.size === 0) {
      window.removeEventListener("dragend", clearFileDrags);
    }
    return;
  }
  if (fileDragClears.size === 0) window.addEventListener("dragend", clearFileDrags, { once: true });
  fileDragClears.add(setActive);
}

/**
 * A clock that advances exactly when a snooze wake time passes, so a woken
 * thread leaves the shelf on time without a per-second clock.
 */
export function useSnoozeWakeClock(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null | undefined }>,
): number {
  const [clockMs, setClockMs] = React.useState(() => Date.now());
  const wakeTimes: number[] = [];
  let nextWakeAt: number | null = null;
  for (const thread of threads) {
    const wakeAt = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
    if (!(wakeAt > clockMs)) continue;
    wakeTimes.push(wakeAt);
    if (nextWakeAt === null || wakeAt < nextWakeAt) nextWakeAt = wakeAt;
  }
  const woke = useDeadlinePassed(nextWakeAt);
  // Advancing to the latest wake that has passed skips every wake that elapsed
  // meanwhile, e.g. across a laptop sleep. Stepping one wake at a time would
  // re-render once per elapsed wake and hit React's limit.
  if (woke && nextWakeAt !== null) {
    let nextClockMs = nextWakeAt;
    for (const wakeAt of wakeTimes) {
      if (wakeAt > nextClockMs && deadlineStore(wakeAt).getSnapshot()) nextClockMs = wakeAt;
    }
    setClockMs(nextClockMs);
    return nextClockMs;
  }
  return clockMs;
}

export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const [retained, setRetained] = React.useState<{
    readonly key: string;
    readonly value: T;
  } | null>(null);
  if (key !== null && value !== null && (retained?.key !== key || retained.value !== value)) {
    setRetained({ key, value });
  }
  if (value !== null) return value;
  return key !== null && retained?.key === key ? retained.value : null;
}

// Sortable owns drag transforms; replaying committed order would animate drops twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Snoozed rows cannot accept drops without a wake time. Working rows only drag out as chat context.

export type SidebarSection = "pinned" | "active" | "working" | "snoozed" | "settled";

export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection {
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  | "pinned-header"
  | "active-placeholder"
  | "settled-placeholder"
  | "pinned-divider"
  | "working-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker };

export function sidebarListItemId(item: SidebarListItem): string {
  return item.kind === "thread" ? item.key : sidebarMarkerId(item.marker);
}

function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, overIndex);
  if (section === "working" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") currentSection = "active";
      else if (
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
    } else if (currentSection === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      readonly order: readonly string[] | null;
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "working" || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

export function resolveSidebarSweepKeys(
  orderedKeys: readonly string[],
  originKey: string,
  targetKey: string,
  canApply: (key: string) => boolean,
): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y;
  let key: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break;
    key = row.dataset.threadItem ?? null;
  }
  return key;
}

export function resolveSidebarReorderableThreadKeys(input: {
  readonly threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId" | "id">>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<EnvironmentServerConfig, "environment">>;
  readonly connectedEnvironmentIds: readonly EnvironmentId[];
}) {
  const connectedEnvironmentIds = new Set(input.connectedEnvironmentIds);
  const draggableThreadKeys = new Set<string>();
  const activeReorderableThreadKeys = new Set<string>();

  for (const thread of input.threads) {
    // Config is cached for offline rendering, so its presence does not make a row writable.
    if (
      !connectedEnvironmentIds.has(thread.environmentId) ||
      !input.serverConfigs.has(thread.environmentId)
    ) {
      continue;
    }

    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    activeReorderableThreadKeys.add(threadKey);
    draggableThreadKeys.add(threadKey);
  }

  return { draggableThreadKeys, activeReorderableThreadKeys };
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  readonly activeTimeOrdered?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (activeSection === "working") return { kind: "none" };
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  const arrange = (
    order: readonly string[],
    keysById: ReadonlyMap<string, string | null | undefined>,
    writable: ReadonlySet<string> | undefined,
  ) => {
    if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
    if (!writable.has(activeKey)) return null;
    const assignments = planPinnedReorder({
      orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
      keysById,
      movedId: activeKey,
    });
    if (assignments.some(({ id }) => !writable.has(id))) return null;

    // Keyless Active rows sort before keyed rows; keyless Pinned rows sort after them.
    // Materializing any row across a frozen keyless boundary cannot persist that position.
    const assignedIds = new Set(assignments.map(({ id }) => id));
    let hasFrozenKeylessBefore = false;
    let hasAssignedBefore = false;
    for (const id of order) {
      const isFrozenKeyless = !writable.has(id) && keysById.get(id) == null;
      const isAssigned = assignedIds.has(id);
      if (
        (target.section === "active" && isFrozenKeyless && hasAssignedBefore) ||
        (target.section === "pinned" && isAssigned && hasFrozenKeylessBefore)
      ) {
        return null;
      }

      hasFrozenKeylessBefore ||= isFrozenKeyless;
      hasAssignedBefore ||= isAssigned;
    }

    return assignments;
  };
  switch (target.section) {
    case "active": {
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
            };
      }
      const order = target.activeOrder;
      if (
        activeSection === "active" &&
        order.length === activeOrder.length &&
        order.every((key, index) => key === activeOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, activeKeysById, activeReorderableKeys);
      if (assignments === null) return { kind: "none" };
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled" ? { kind: "none" } : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, pinnedKeysById, reorderableKeys);
      if (assignments === null) return { kind: "none" };
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
  >,
>(thread: T, section: "pinned" | "active" | "settled", now: string, orderKey?: string): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined ? { activeOrderKey: orderKey } : {}),
  };
}

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

type ThreadTraversalDirection = "previous" | "next";

/** Exclude only successful deletions from shared-worktree checks. */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

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
    if (didArchive || result._tag === "Success") archivedThreadKeys.push(entry.threadKey);
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

export function isSidebarSubagentThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

// Subagent threads have no sidebar row, so an open subagent is represented by
// its nearest non-subagent ancestor. A broken chain (missing parent, cycle,
// other environment) resolves to the thread itself, which then matches no row.
export function resolveSidebarRowThreadId(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  threads: readonly Pick<SidebarThreadSummary, "id" | "environmentId" | "lineage">[],
): ThreadId {
  const findThread = (id: ThreadId) =>
    threads.find((thread) => thread.id === id && thread.environmentId === environmentId);
  const visited = new Set<ThreadId>();
  let thread = findThread(threadId);
  while (thread !== undefined && isSidebarSubagentThread(thread)) {
    if (thread.lineage.parentThreadId === null || visited.has(thread.id)) return threadId;
    visited.add(thread.id);
    thread = findThread(thread.lineage.parentThreadId);
  }
  return thread?.id ?? threadId;
}

/**
 * `delegatedUnderParent` holds the tasks linked environments run for a thread
 * the sidebar lists, by thread key; they show under that thread, as subagents do.
 */
export function filterSidebarV2VisibleThreads<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "environmentId" | "id" | "lineage"> & {
    projectId: string;
  },
>(
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  delegatedUnderParent: ReadonlySet<string>,
): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isShownUnderParent(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.lineage,
        delegatedUnderParent,
      ) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
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

export function buildBulkUnpinContextMenuItem(input: {
  pinnedCount: number;
}): ContextMenuItem<"unpin"> | null {
  if (input.pinnedCount === 0) return null;
  return { id: "unpin", label: `Unpin (${input.pinnedCount})` };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Failed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Guest Request"
    | "Waiting"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  "Guest Request": 3.75,
  Failed: 3.5,
  Working: 3,
  Connecting: 3,
  Waiting: 2.5,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
  blockedOnThreadWait?: boolean | undefined;
};

/**
 * Thread jump hints appear once the jump modifier has been held for a moment,
 * so a quick shortcut never flashes them, and hide as soon as it is released.
 */
export function useThreadJumpHintsVisible(shouldShow: boolean): boolean {
  const [showAt, setShowAt] = React.useState<number | null>(null);
  // The clock is read inside the updater: the compiler caches a bare clock read
  // in render once per instance, so a second hold would reuse the first deadline.
  // React discards this render and re-runs with the update.
  if (shouldShow !== (showAt !== null)) {
    setShowAt(shouldShow ? () => deadlineAfter(THREAD_JUMP_HINT_SHOW_DELAY_MS) : null);
  }
  return useDeadlinePassed(showAt);
}

export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  // Server visits override local watermarks, including mark-unread rewinds; use local values only on older
  // servers.
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Unopened threads' failures still count as unseen, unlike completions. */
function hasUnseenFailure(thread: ThreadStatusInput): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

// Suppress trailing double-click navigation; keyboard and synthetic clicks use detail 0.
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

function nodeClosest(node: object | null, selector: string): unknown {
  if (node === null || !("closest" in node) || typeof node.closest !== "function") return null;
  return node.closest(selector);
}

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

export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function shouldRecedeSidebarThread(input: {
  status: SidebarThreadStatus;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isSelected: boolean;
}): boolean {
  if (
    input.isActive ||
    input.isSelected ||
    input.status === "input" ||
    input.status === "request"
  ) {
    return false;
  }
  if (input.status === "working" || input.status === "waiting") return true;
  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }
  return false;
}

type SidebarThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
>;

export function resolveSidebarThreadStatus(thread: SidebarThreadStatusInput): SidebarThreadStatus {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/**
 * The dot on a closed boring-sidebar folder: the most urgent state among its
 * hidden threads. Waiting threads stay quiet, like their rows.
 */
export function resolveSidebarFolderDot(
  threads: ReadonlyArray<ThreadStatusInput & SidebarThreadStatusInput>,
): "attention" | "failed" | "unread" | "working" | null {
  const statuses = new Set(threads.map(resolveSidebarThreadStatus));
  if (
    statuses.has("input") ||
    statuses.has("approval") ||
    statuses.has("request") ||
    statuses.has("limited")
  ) {
    return "attention";
  }
  if (statuses.has("failed")) return "failed";
  // Rows show Done only for ready threads, so the dot follows the same rule.
  const hasUnread = threads.some(
    (thread) => resolveSidebarThreadStatus(thread) === "ready" && hasUnseenCompletion(thread),
  );
  if (hasUnread) return "unread";
  if (statuses.has("working")) return "working";
  return null;
}

/**
 * Keys the old per-project sidebar saved folder open state under, most
 * specific first, for `resolveProjectExpanded`. Boring folders read and write
 * the same keys, so a legacy user's closed folders stay closed after regrouping.
 */
export function sidebarFolderExpansionKeys(group: {
  readonly projectKey: string;
  readonly memberProjects: ReadonlyArray<{
    readonly physicalProjectKey: string;
    readonly workspaceRoot: string;
  }>;
}): string[] {
  return [
    group.projectKey,
    ...group.memberProjects.map((member) => member.physicalProjectKey),
    ...group.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

/**
 * Boring sidebar folders. Folders follow `groups` order and threads keep their
 * input order. A project with no threads gets a folder only with `keepEmpty`.
 * A thread whose project is in no group has no folder and is left out.
 */
export function groupSidebarThreadsByProject<
  TGroup extends {
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: string;
    }>;
  },
  TThread extends Pick<SidebarThreadSummary, "environmentId" | "projectId">,
>(
  groups: readonly TGroup[],
  threads: readonly TThread[],
  keepEmpty: boolean,
): Array<{ group: TGroup; threads: TThread[] }> {
  const folders = groups.map((group) => ({ group, threads: [] as TThread[] }));
  const folderByProject = new Map<string, (typeof folders)[number]>();
  for (const folder of folders) {
    for (const ref of folder.group.memberProjectRefs) {
      folderByProject.set(`${ref.environmentId}:${ref.projectId}`, folder);
    }
  }
  for (const thread of threads) {
    folderByProject.get(`${thread.environmentId}:${thread.projectId}`)?.threads.push(thread);
  }
  return keepEmpty ? folders : folders.filter((folder) => folder.threads.length > 0);
}

export type SidebarV2TopStatusKind =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "input"
  | "request"
  | "waiting"
  | "woke"
  | "working";

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

export { sortActiveThreadsByOrderKey as sortThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";
export {
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";

// Optional signal fields the active-section sort reads. Every field already
// lives on the thread shell, so no mode adds a subscription or poll.
type ActiveSortInput = {
  readonly id: string;
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
  readonly activeOrderKey?: string | null | undefined;
  readonly environmentId?: string | undefined;
  readonly workType?: string | null | undefined;
  readonly stage?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly linkedPullRequest?: { readonly number: number } | null | undefined;
  readonly pullRequests?: ReadonlyArray<{ readonly source: string }> | undefined;
  readonly branchPullRequest?: object | null | undefined;
};

/**
 * Whether the row would show a pull request badge. Links live in `pullRequests`
 * (minus dismissed stack members, as in visibleThreadPullRequests), with the
 * branch's own pull request and the legacy single link as fallbacks.
 */
function threadHasPullRequest(thread: ActiveSortInput): boolean {
  return (
    (thread.pullRequests ?? []).some((link) => link.source !== "stack-dismissed") ||
    thread.branchPullRequest != null ||
    thread.linkedPullRequest != null
  );
}

/**
 * Layers a sort preference over an already-ordered active section. "default"
 * returns the given order untouched; other modes bucket threads into coarse tiers
 * and keep the given order inside each, so a row can move between tiers but never
 * jitter within one. Keys read off the thread shell, so no mode adds a subscription.
 */
export function tierActiveThreadsForSidebar<T extends ActiveSortInput>(
  orderedThreads: readonly T[],
  sortBy: SidebarSortBy,
  taxonomy: readonly TaxonomyEntryLike[],
): readonly T[] {
  if (sortBy === "default") return orderedThreads;

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
        return threadHasPullRequest(thread) ? 0 : 1;
    }
  };

  // toSorted is stable, so threads sharing a tier keep the given order.
  return orderedThreads.toSorted((left, right) => rankOf(left) - rankOf(right));
}

/**
 * The arranged order (sortActiveThreadsByOrderKey) with a sort preference
 * tiered on top. When grouping is on, the caller sorts before grouping so this
 * order becomes the within-group order.
 */
export function sortActiveThreadsForSidebar<T extends ActiveSortInput>(
  threads: readonly T[],
  sortBy: SidebarSortBy,
  taxonomy: readonly TaxonomyEntryLike[],
): readonly T[] {
  return tierActiveThreadsForSidebar(sortActiveThreadsByOrderKey(threads), sortBy, taxonomy);
}

/**
 * Orders project groups by a persisted manual order, not activity, so a group
 * never jumps as its threads work. Listed projects come first in that order; the
 * rest follow alphabetically, so a new project lands predictably instead of leaping
 * to the top.
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
 * Groups already-ordered active threads under their logical project. `projects`
 * decides group order and each group keeps the threads' input order. Empty groups
 * are dropped, and threads with no known project collect in a trailing catch-all.
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
 * The stage pipeline's fill boundary: the thread's stage index in the taxonomy, so
 * dots up to it fill and later ones stay hollow. -1 (all hollow) with no stage or
 * an id the taxonomy no longer lists, which has no position in the lifecycle.
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
 * Whether a thread's branch is the repo's default and so not worth showing.
 * `isDefaultRef` may be passed only when the checked-out ref is this thread's
 * branch; otherwise the common default names decide. An absent branch is not one.
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
 * Groups already-ordered active threads by `workType` or `stage`. Group order is
 * taxonomy entries in taxonomy order, then ids the taxonomy no longer lists in
 * first-appearance order, then a trailing "Unclassified" bucket for empty values.
 * Each group keeps the threads' input order.
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

/** One active-section group after the group-by setting resolves. */
export interface SidebarActiveGroup<TProject, TThread> {
  readonly key: string;
  readonly threads: readonly TThread[];
  /** Project groups name the project, so their rows drop it; the catch-all and taxonomy groups do not. */
  readonly showProjectIdentity: boolean;
  readonly header:
    | { readonly kind: "project"; readonly project: TProject | null }
    | {
        readonly kind: "taxonomy";
        readonly label: string;
        readonly color: string | null;
        readonly known: boolean;
      };
}

export interface SidebarActiveArrangement<TProject> {
  readonly groupBy: SidebarGroupBy;
  readonly sortBy: SidebarSortBy;
  /** Project groups in header order; see orderProjectGroupsByManualOrder. */
  readonly projects: readonly TProject[];
  readonly projectSortOverrides: Readonly<Record<string, SidebarSortBy>>;
  readonly taxonomy: {
    readonly workTypes: readonly TaxonomyEntryLike[];
    readonly stages: readonly TaxonomyEntryLike[];
  };
}

/**
 * The active section's visual plan: an optional sort tier over the given order,
 * then optional groups. `orderedThreads` is the flat order as rendered, which
 * keyboard traversal, jump hints, range select and sweeps index by. With default
 * sort and no grouping it is the input array itself, so the list is untouched.
 */
export function arrangeActiveThreadsForSidebar<
  TProject extends {
    readonly projectKey: string;
    readonly memberProjectRefs: readonly {
      readonly environmentId: string;
      readonly projectId: string;
    }[];
  },
  TThread extends ActiveSortInput & {
    readonly environmentId: string;
    readonly projectId: string;
  },
>(
  threads: readonly TThread[],
  arrangement: SidebarActiveArrangement<TProject>,
): {
  readonly groups: readonly SidebarActiveGroup<TProject, TThread>[] | null;
  readonly orderedThreads: readonly TThread[];
} {
  const { groupBy, sortBy, projects, projectSortOverrides, taxonomy } = arrangement;
  if (groupBy === "off") {
    return {
      groups: null,
      orderedThreads: tierActiveThreadsForSidebar(threads, sortBy, taxonomy.workTypes),
    };
  }
  const groups: readonly SidebarActiveGroup<TProject, TThread>[] =
    groupBy === "project"
      ? // A project's own sort override decides its within-group order.
        buildSidebarThreadGroups({ projects, threads }).map((group) => ({
          key: group.key,
          threads: tierActiveThreadsForSidebar(
            group.threads,
            resolveProjectEffectiveSort(group.key, projectSortOverrides, sortBy),
            taxonomy.workTypes,
          ),
          showProjectIdentity: group.project === null,
          header: { kind: "project", project: group.project },
        }))
      : buildSidebarThreadGroupsByTaxonomy({
          taxonomy: groupBy === "workType" ? taxonomy.workTypes : taxonomy.stages,
          threads: tierActiveThreadsForSidebar(threads, sortBy, taxonomy.workTypes),
          getValue: (thread) => (groupBy === "workType" ? thread.workType : thread.stage),
          unclassifiedLabel: "Unclassified",
        }).map((group) => ({
          key: group.key,
          threads: group.threads,
          showProjectIdentity: true,
          header: { kind: "taxonomy", label: group.label, color: group.color, known: group.known },
        }));
  return { groups, orderedThreads: groups.flatMap((group) => group.threads) };
}

export { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
export { sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar } from "@t3tools/client-runtime/state/thread-sort";

const EMPTY_CONTENT_MATCH_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * Sidebar search results: title, branch, and pull request matches ranked as
 * the command palette ranks them, then threads listed only because their
 * messages match, in `contentMatchKeys` order.
 */
export function searchSidebarThreads<
  T extends ThreadSearchShell & {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  },
>(
  threads: readonly T[],
  query: string,
  contentMatchKeys: ReadonlySet<string> = EMPTY_CONTENT_MATCH_KEYS,
  now = Date.now(),
): { readonly titleMatches: T[]; readonly contentMatches: T[] } {
  const normalizedQuery = foldSearchQuery(query);
  if (normalizedQuery.length === 0) return { titleMatches: [], contentMatches: [] };
  const titleMatches = rankSearchItems(threads, (thread, options) =>
    scoreThreadSearch(normalizedQuery, threadSearchSubject(thread, null), now, {
      ...options,
      picks: false,
    }),
  ).map(({ item }) => item);
  const listed = new Set(titleMatches);
  // In the order the server ranked their messages, as the palette lists them.
  const threadByKey = new Map(
    threads.map((thread) => [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
  const contentMatches = [...contentMatchKeys].flatMap((key) => {
    const thread = threadByKey.get(key);
    return thread && !listed.has(thread) ? [thread] : [];
  });
  return { titleMatches, contentMatches };
}

export function pullRequestMatchesSearchQuery(
  pullRequest: Parameters<typeof threadPullRequestSearchTerms>[0],
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return false;
  const haystack = normalizeSearchText(threadPullRequestSearchTerms(pullRequest).join(" "));
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function filterSidebarProjectScopeItems<TItem extends { readonly value: string }>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => item.value !== "all" && input.matches(item, query));
}

interface SidebarProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}

type SidebarProjectScopeMenuAction =
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

export function resolveWorkingStartedAt(
  thread: Pick<SidebarThreadSummary, "latestRun" | "runtime">,
): string | null {
  return resolveThreadWorkingStartedAt(thread);
}

// Which source owns a row's status slot. Live work always wins, so in-flight work
// is never hidden. An unread Done comes next, or a PR-linked thread would lose its
// completion cue; once read it clears and the PR's review/merge state becomes the
// resting status. "none" leaves the relative time.
export type TopLineStatusSource = "live" | "done" | "pr" | "none";

export function resolveTopLineStatusSource(input: {
  hasLiveStatus: boolean;
  hasPrReviewStatus: boolean;
  hasUnreadCompletion: boolean;
}): TopLineStatusSource {
  if (input.hasLiveStatus) return "live";
  if (input.hasUnreadCompletion) return "done";
  if (input.hasPrReviewStatus) return "pr";
  return "none";
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return {
      label: "Guest Request",
      colorClass: "text-guest-foreground",
      dotClass: "bg-guest",
      pulse: false,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return {
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };
  }

  if (hasUnseenFailure(thread)) {
    return {
      label: "Failed",
      colorClass: "text-red-600 dark:text-red-300/90",
      dotClass: "bg-red-500 dark:bg-red-300/90",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
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
function getProjectSortTimestamp(
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

  // Project timestamps scan all threads; compute once per project instead of per comparison.
  return projects
    .map((project) => ({
      project,
      timestamp: getProjectSortTimestamp(project, getProjectThreads(project), sortOrder),
    }))
    .sort((left, right) => {
      const byTimestamp =
        right.timestamp === left.timestamp ? 0 : right.timestamp > left.timestamp ? 1 : -1;
      return byTimestamp || compareTies(left.project, right.project);
    })
    .map(({ project }) => project);
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

export function sortSidebarV2ProjectGroups<
  TProject extends LogicalSidebarProject,
  TThread extends ScopedSidebarThread &
    Pick<SidebarThreadSummary, "environmentId" | "id" | "lineage">,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
  delegatedUnderParent: ReadonlySet<string>,
): TProject[] {
  return sortLogicalProjectsForSidebar(
    projects,
    filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent),
    sortOrder,
  );
}

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
