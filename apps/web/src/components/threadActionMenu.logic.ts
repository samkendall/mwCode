import type { ContextMenuItem, HarnessTaxonomy } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

/** Sentinel appended to a classification value to clear the field. */
export const CLASSIFICATION_CLEAR_VALUE = "__clear__";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>`, and classification picks as
 * `set-work-type:<id>` / `set-stage:<id>` (with `__clear__` to unset), so the
 * union stays closed while the option lists remain data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "filter-by-project"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "set-work-type"
  | `set-work-type:${string}`
  | "set-stage"
  | `set-stage:${string}`
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

export interface ThreadActionMenuState {
  readonly branch: string | null;
  /**
   * Project scoping for the thread list. Null on surfaces with no scoped
   * list behind the menu (the chat header), where the item must not show.
   */
  readonly projectFilter: {
    readonly label: string;
    /** True when the list is already scoped to this thread's project. */
    readonly isActive: boolean;
  } | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an active turn, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /**
   * Fork-local classification config for the "Set work type"/"Set stage"
   * submenus. Absent on surfaces that don't offer classification (the menu
   * simply omits those entries).
   */
  readonly classification?: {
    readonly taxonomy: HarnessTaxonomy;
    readonly workType: string | null;
    readonly stage: string | null;
  };
}

function buildClassificationMenuItem(input: {
  readonly parentId: "set-work-type" | "set-stage";
  readonly label: string;
  readonly icon: string;
  readonly entries: HarnessTaxonomy["workTypes"];
  readonly current: string | null;
}): ContextMenuItem<ThreadActionMenuId> {
  const current = input.current?.trim() || null;
  return {
    id: input.parentId,
    label: input.label,
    icon: input.icon,
    children: [
      // ContextMenuItem has no checkbox affordance, so the active option is
      // marked with a leading check in its label (native-menu convention).
      ...input.entries.map((entry) => ({
        id: `${input.parentId}:${entry.id}` as const,
        label: entry.id === current ? `✓ ${entry.label}` : entry.label,
      })),
      {
        id: `${input.parentId}:${CLASSIFICATION_CLEAR_VALUE}` as const,
        label: "Clear",
        separatorBefore: true,
        disabled: current === null,
      },
    ],
  };
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu share labels, ordering, and capability gating.
 * Each surface supplies state for the actions it supports.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  { id: "snooze:custom" as const, label: "Custom…", separatorBefore: true },
                ],
              },
        ]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(state.classification
      ? [
          buildClassificationMenuItem({
            parentId: "set-work-type",
            label: "Set work type",
            icon: "tag",
            entries: state.classification.taxonomy.workTypes,
            current: state.classification.workType,
            // Stage submenu below reuses the same builder; the shared
            // signature types entries as workTypes but the shape matches.
          }),
          buildClassificationMenuItem({
            parentId: "set-stage",
            label: "Set stage",
            icon: "git-branch",
            entries: state.classification.taxonomy.stages,
            current: state.classification.stage,
          }),
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    ...(state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    // Archive removes the thread from the sidebar while keeping its
    // conversation under Settings > Archived threads — distinct from Settle
    // (stays visible in the Settled shelf) and Delete (clears history for
    // good), so it sits beside Delete without borrowing its destructive
    // styling.
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
}
