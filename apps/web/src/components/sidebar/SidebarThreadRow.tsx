import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadTerminalStatusButton } from "../ThreadStatusIndicators";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { useDeadlinePassed } from "~/hooks/useDeadline";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
} from "@t3tools/client-runtime/state/thread-settled";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { resolveSettledThreadTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { type EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  formatWorkingDurationLabel,
  resolveThreadProviderStack,
} from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type HarnessTaxonomy,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  PinIcon,
  PinOffIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { formatRelativeTimeLabel, parseTimestampDate } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  animateSidebarLayoutChanges,
  hasUnseenCompletion,
  isDefaultThreadBranch,
  resolveClassificationBadge,
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  resolveTopLineStatusSource,
  shouldRecedeSidebarThread,
  resolveWorkingStartedAt,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
  setFileDragActive,
} from "../Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadWorktreeIndicator,
  prBadgePresentation,
  prStatusIndicator,
  resolvePrReviewStatus,
  resolveThreadPullRequestBadge,
  settledPrHoverColorClass,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "../ThreadStatusIndicators";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { useThreadShell } from "../../state/entities";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import {
  SidebarThreadClassificationBadges,
  type ClassificationDimension,
} from "../SidebarThreadClassificationBadge";
import { ThreadSearchMatchExcerpt } from "../ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
export type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "enabled"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;
function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return props.timestamp === null
    ? null
    : compactSidebarTimeLabel(
        formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`)),
      );
}

function threadTimeTimestamp(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel startedMs={startedMs} />;
}

// Self-ticking so only this span re-renders each second, not the whole row;
// the shared tick lands every working row's update in the same frame.
function WorkingDurationLabel(props: { startedMs: number }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">{formatWorkingDurationLabel(nowMs - props.startedMs)}</span>
  );
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      acpRegistryAgentId={currentEntry.acpRegistryAgentId}
      acpRegistryIconUrl={currentEntry.acpRegistryIconUrl}
      showBadge={showInstanceBadge}
      size="compact"
      iconClassName="opacity-60"
    />
  );
  if (stack.length === 1) {
    return <span className="inline-flex shrink-0 items-center">{current}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {stack.slice(0, -1).map((instanceId) => {
        const entry = props.providerEntryByInstanceId.get(instanceId);
        if (entry === undefined) return null;
        return (
          <ProviderInstanceIcon
            key={instanceId}
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            iconClassName="size-3 opacity-35 grayscale"
          />
        );
      })}
      <span className="relative z-10 inline-flex items-center">{current}</span>
    </span>
  );
}

function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard
        title={thread.title}
        footer={
          supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word">
              You're currently checked out on another branch.
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelLabel} · ${providerEntry.displayName}`
                : modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              Handed off from {previousProviderNames.join(", ")}
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              thread.runtime.lastErrorClass === "usage_limit" ? "text-warning" : "text-error",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {thread.runtime.lastErrorClass === "usage_limit"
                ? "Usage limit reached"
                : "Error occurred"}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
  environmentId: EnvironmentId;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat, environmentId } = props;
  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, environmentId)
    : [];
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Snooze thread"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              const picked = pickSnoozePreset(presets, preset.id, timestampFormat, environmentId);
              if (picked) onSnooze(picked);
            }}
          >
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        {presets.length > 0 ? <MenuSeparator /> : null}
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
export const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

// useSortable memoizes on its `disabled` object, so a fresh one per render
// re-renders every row and marker on each sidebar update.
export const SIDEBAR_SORTABLE_DRAG_DISABLED = { draggable: true } as const;
const SIDEBAR_SORTABLE_DRAG_ENABLED = { draggable: false } as const;

// Takes the row's props rather than a render function: a closure from the
// sidebar body is new on every sidebar render, which rebuilt the bag and
// re-rendered every memoized row with it.
function SortableThreadRow(
  props: Omit<SidebarThreadRowProps, "sortable"> & {
    sortableId: string;
    sortableDisabled: boolean;
    contextDrag: boolean;
  },
) {
  const { sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  const canOperateThread = useEnvironmentScope(
    rowProps.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    disabled:
      sortableDisabled || !canOperateThread
        ? SIDEBAR_SORTABLE_DRAG_DISABLED
        : SIDEBAR_SORTABLE_DRAG_ENABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // dnd-kit memoizes each field but not the bag, so the memoized row would
  // rerender on every shell update without this.
  const bag = {
    listeners,
    setNodeRef,
    transform: contextDrag ? null : transform,
    transition: contextDrag && isDragging ? "transform 150ms ease-out" : transition,
    isDragging: isDragging && !contextDrag,
  };
  // The sidebar arranges rows from quiet shells, which hold still while a
  // thread streams; reading the live shell here re-renders only this row.
  const thread =
    useThreadShell(scopeThreadRef(rowProps.thread.environmentId, rowProps.thread.id)) ??
    rowProps.thread;
  // Keyed by variant so a card/slim switch remounts the row.
  return <SidebarThreadRow key={rowProps.variant} {...rowProps} thread={thread} sortable={bag} />;
}

// Outside the list's sortable order, so it never registers as a drop target.
function StaticThreadRow(props: Omit<SidebarThreadRowProps, "sortable">) {
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  return <SidebarThreadRow key={props.variant} {...props} thread={thread} />;
}

/**
 * A list row. Rows under a group header are `grouped`: their position is the
 * group's sort, not a slot they can be dragged into, so they skip dnd-kit entirely.
 */
export function SidebarListThreadRow(
  props: Parameters<typeof SortableThreadRow>[0] & { grouped: boolean },
) {
  const { grouped, sortableId, sortableDisabled, contextDrag, ...rowProps } = props;
  return grouped ? (
    <StaticThreadRow {...rowProps} />
  ) : (
    <SortableThreadRow
      {...rowProps}
      sortableId={sortableId}
      sortableDisabled={sortableDisabled}
      contextDrag={contextDrag}
    />
  );
}
export type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";
const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
};

const TOP_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const;

function TopStatusIcon(props: { icon: keyof typeof TOP_STATUS_ICONS; className: string }) {
  const Icon = TOP_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}

type SidebarThreadRowProps = {
  thread: SidebarThreadSummary;
  // "folder" is a one-line row inside a boring sidebar project folder;
  // "folder-multiline" adds the card's branch and PR line under it. "cozy" is
  // the two-line density between the card and the one-line slim row.
  variant: "card" | "cozy" | "slim" | "folder" | "folder-multiline";
  navigationParent?: string | undefined;
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  pinningSupported: boolean;
  isPinned: boolean;
  // False while the row sits under a project group header: the header already
  // names the project, so the row drops its favicon and project label.
  showProjectIdentity: boolean;
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
  sweepAction: SidebarSweepAction | null;
  snoozeWakeLabelText: string | null;
  wokeAt: string | null;
  isActive: boolean;
  // Set on the active row only; scrolls it into view when a reveal is owed.
  revealRef?: ((row: HTMLElement, threadKey: string) => void) | undefined;
  // Unlike isActive, never true for the ancestor standing in for an open
  // subagent: drafts and PR clicks care about which composer is on screen.
  isRouteThread: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  scratchMachineLabel: string | null;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  // Effective work-type/stage vocabulary for this thread's environment. Chips
  // resolve labels + colors from it and offer its options on click.
  harnessTaxonomy: HarnessTaxonomy;
  onUpdateClassification: (
    threadRef: ScopedThreadRef,
    dimension: ClassificationDimension,
    id: string | null,
  ) => void;
  onResumeStageAuto: (threadRef: ScopedThreadRef) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
};

// Mounted only while renaming, so each rename starts uncommitted.
function ThreadRenameInput(props: {
  title: string;
  onTitleChange: (title: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={props.title}
      dir="auto"
      aria-label="Thread title"
      onChange={(event) => props.onTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    isRenaming,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onRenameTitleChange,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onUnpin,
    onUpdateClassification,
    onResumeStageAuto,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const { revealRef } = props;
  const rowRef = (row: HTMLElement | null) => {
    if (row !== null) revealRef?.(row, threadKey);
    return leaseRowRef(row);
  };
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isRouteThread;
  const handleDiscardDraftClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    discardComposerDraft(threadRef);
  };

  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  const shouldRecede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isSelected,
  });
  // The linked PR's review/merge verdict, read off signals the row already has
  // (no extra fetch). Promoted into the status slot for shipped work, so a read
  // thread says "Awaiting review" / "Ready to merge" / "Merged".
  const prReviewStatus = resolvePrReviewStatus(pr, linkedPullRequestStatus?.signals);
  const liveTopStatus =
    status === "working"
      ? {
          label: thread.goal?.status === "active" ? "Goal" : "Working",
          icon: "working" as const,
          className: "text-info-foreground",
        }
      : status === "waiting"
        ? {
            label: "Waiting",
            icon: "waiting" as const,
            className: "text-muted-foreground",
          }
        : status === "approval"
          ? {
              label: "Approval",
              icon: "approval" as const,
              className: "text-warning-foreground",
            }
          : status === "input"
            ? {
                label: "Input",
                icon: "input" as const,
                className: "text-indigo-600 dark:text-indigo-300",
              }
            : status === "request"
              ? {
                  label: "Request",
                  icon: "request" as const,
                  className: "text-guest-foreground",
                }
              : status === "limited"
                ? {
                    label: "Limited",
                    icon: "failed" as const,
                    className: "text-warning-foreground",
                  }
                : status === "failed"
                  ? {
                      label: "Failed",
                      icon: "failed" as const,
                      className: "text-error-foreground",
                    }
                  : isWoke
                    ? {
                        label: "Woke",
                        icon: "woke" as const,
                        className: "text-warning-foreground",
                      }
                    : null;
  // Live work never yields; a fresh unread Done outranks the PR status, which is
  // the resting status once the completion is read; otherwise the row shows its time.
  const topLineStatusSource = resolveTopLineStatusSource({
    hasLiveStatus: liveTopStatus !== null,
    hasPrReviewStatus: prReviewStatus !== null,
    hasUnreadCompletion: isUnread,
  });
  const topStatus =
    topLineStatusSource === "live"
      ? liveTopStatus
      : topLineStatusSource === "done"
        ? {
            label: "Done",
            icon: "done" as const,
            className: "text-success-foreground",
          }
        : topLineStatusSource === "pr" && prReviewStatus !== null
          ? { label: prReviewStatus.label, icon: null, className: prReviewStatus.colorClass }
          : null;
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  // A branch label that repeats the repo's default adds nothing. `isDefaultRef`
  // counts only when the checked-out ref is this thread's branch; otherwise the
  // name decides.
  const branchIsDefaultRef =
    gitStatus.data?.refName != null &&
    gitStatus.data.refName === thread.branch &&
    gitStatus.data.isDefaultRef === true;
  const showBranch =
    thread.branch != null && !isDefaultThreadBranch(thread.branch, branchIsDefaultRef);
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);
  // The badge shade reflects the review/merge signals the linked PR carries. A PR
  // with none falls back to the coarse open/closed/merged state.
  const prBadgeInfo = pr ? prBadgePresentation(pr.state, linkedPullRequestStatus?.signals) : null;
  const settledPrHoverClass = pr
    ? settledPrHoverColorClass(pr.state === "open" && pr.isDraft ? "draft" : pr.state)
    : undefined;
  // The shared badge control takes its color and label from the status it is
  // handed, so the review-aware shade rides in on that rather than forking it.
  const prBadgeStatus =
    prStatus === null
      ? null
      : {
          ...prStatus,
          colorClass:
            variant === "slim" && variantAction === "unsettle"
              ? props.isActive
                ? "text-secondary-label"
                : cn("text-secondary-label transition-colors", settledPrHoverClass)
              : (prBadgeInfo?.colorClass ?? prStatus.colorClass),
          tooltip: prBadgeInfo
            ? `${prStatus.tooltipLead.replace(/ - .*$/, ` - ${prBadgeInfo.statusLabel}`)}: ${prStatus.tooltipTitle}`
            : prStatus.tooltip,
        };

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;
  const hasProviderHandoff = resolveThreadProviderStack(thread).length > 1;

  const isRemote = thread.environmentId !== props.currentEnvironmentId;
  const showsScratchMachine = !thread.branch && props.scratchMachineLabel !== null;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={thread}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      providerEntry={providerEntry}
      providerEntryByInstanceId={props.providerEntryByInstanceId}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
    />
  );

  const handleClick = (event: ReactMouseEvent) => {
    onThreadClick(event, threadRef);
  };
  const handleAcknowledgeWokeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.wokeAt === null) return;
    onAcknowledgeWoke(threadRef, props.wokeAt);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key === "F2" &&
      !isRenaming &&
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    ) {
      event.preventDefault();
      onStartRename(threadRef, thread.title);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onThreadActivate(threadRef);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
    if (
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
      isRenaming ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    onStartRename(threadRef, thread.title);
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = onFileDropThreads
    ? makeWorkspaceFileDropHandlers({
        setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      })
    : null;
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSettle(threadRef);
  };
  const handleActionPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    onActionSweepStart(threadRef, variantAction, event.nativeEvent);
  };
  const handleUnsettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsettle(threadRef);
  };
  const handleUnsnoozeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(threadRef);
  };
  const handleUnpinClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnpin(threadRef);
  };
  const handleSnoozePreset = (preset: Pick<SnoozePreset, "snoozedUntil">) => {
    onSnooze(threadRef, preset);
  };
  const handleUpdateClassification = (dimension: ClassificationDimension, id: string | null) => {
    onUpdateClassification(threadRef, dimension, id);
  };
  const handleResumeStageAuto = () => {
    onResumeStageAuto(threadRef);
  };
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // The React Compiler caches render results on their inputs, so a clock read
  // here would stay frozen until `thread` changes and a queued-turn gate would
  // never reopen. The gate's clock is state, reset with the thread.
  const [snoozeGateClock, setSnoozeGateClock] = useState(() => ({
    thread,
    now: new Date().toISOString(),
  }));
  if (snoozeGateClock.thread !== thread) {
    // oxlint-disable-next-line react/purity -- Reseeds the snooze gate clock only in the render-phase adjustment that runs when the thread changes.
    setSnoozeGateClock({ thread, now: new Date().toISOString() });
  }
  const snoozeGateNow = snoozeGateClock.now;
  const snoozeGateExpiryMs = hasQueuedTurnStart(thread, { now: snoozeGateNow })
    ? Date.parse(thread.latestUserMessageAt ?? "") + QUEUED_TURN_START_GRACE_MS
    : Number.NaN;
  // A gate still closed past its expiry is held by runtime status, not time,
  // so no clock tick can open it.
  const snoozeGateOpensAt =
    Number.isFinite(snoozeGateExpiryMs) && snoozeGateExpiryMs > Date.parse(snoozeGateNow)
      ? snoozeGateExpiryMs + 50
      : null;
  const snoozeGateOpened = useDeadlinePassed(snoozeGateOpensAt);
  if (snoozeGateOpened && snoozeGateOpensAt !== null) {
    setSnoozeGateClock({ thread, now: new Date(snoozeGateOpensAt).toISOString() });
  }
  const showSnoozeButton =
    canOperateThread && props.snoozeSupported && canSnooze(thread, { now: snoozeGateNow });
  // Closing here, not just masking, keeps the menu from reopening when the button returns.
  if (snoozeMenuOpenRaw && !showSnoozeButton) setSnoozeMenuOpen(false);
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  const handlePrClick = (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
    const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
    const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
    if (openedInRightPanel && showInRightPanel && !props.isRouteThread) {
      onThreadActivate(threadRef);
    }
  };

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    variantAction === "unsettle" &&
      !props.isActive &&
      "[&:not(:hover):not(:focus-within)_*]:text-secondary-label",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : shouldRecede
            ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
  const sortable = props.sortable;
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
  const destinationVerb = sortable?.isDragging
    ? props.dropVerb
    : props.sweepAction === "unsnooze"
      ? "wake"
      : props.sweepAction;
  const dragDestination =
    destinationVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {dropVerbBadge[destinationVerb]}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: topStatus?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });

  const title = isRenaming ? (
    <ThreadRenameInput
      title={renamingTitle}
      onTitleChange={onRenameTitleChange}
      onCommit={() => onCommitRename(threadRef, renamingTitle, thread.title)}
      onCancel={onCancelRename}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "min-w-0 flex-1 text-start text-sm transition-opacity motion-reduce:transition-none",
        shouldRecede ? "font-normal" : "font-medium",
        // Live rows keep the card's contrast at compact density too; only the
        // settled and snoozed tails recede.
        variant !== "slim" || variantAction === "settle"
          ? cn(
              "truncate",
              shouldRecede
                ? "text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"
                : status === "failed" && !isUnread && !isWoke
                  ? "text-foreground/95"
                  : "text-foreground",
            )
          : cn(
              "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
              shouldRecede
                ? "text-secondary-label"
                : props.isActive || isWoke || status === "input" || status === "request"
                  ? "text-foreground"
                  : isUnread
                    ? "text-muted-foreground"
                    : "text-secondary-label/70",
            ),
        isRegeneratingTitle && "opacity-55",
      )}
      dir={textDirection(thread.title)}
    >
      {thread.title}
    </span>
  );
  const accessibleTitle = isRenaming ? null : <span className="sr-only">{thread.title}</span>;

  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const handlePrListClick = () => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isRouteThread) onThreadActivate(threadRef);
  };
  const prBadge =
    prBadgeShape?.kind === "stack" || pr || currentLinkedPr ? (
      <ThreadPullRequestBadgeControl
        render={<InlineButton />}
        badge={prBadgeShape}
        pullRequests={thread.pullRequests}
        number={pr?.number ?? currentLinkedPr?.number}
        url={pr?.url ?? currentLinkedPr?.url}
        status={prBadgeStatus}
        onOpenList={handlePrListClick}
        onOpenPullRequest={handlePrClick}
      />
    ) : null;
  const terminalStatusIcon = (
    <ThreadTerminalStatusButton
      threadRef={threadRef}
      terminalIds={runningTerminalIds}
      onThreadActivate={onThreadActivate}
    />
  );
  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsent draft"
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft</TooltipPopup>
    </Tooltip>
  ) : null;
  const showPin =
    props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
  const pinIndicator = showPin ? (
    props.pinningSupported && canOperateThread && !sortable?.isDragging ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin thread"
              onClick={handleUnpinClick}
              className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <PinIcon
            aria-hidden
            className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
          />
          <PinOffIcon
            aria-hidden
            className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
          />
        </TooltipTrigger>
        <TooltipPopup>Unpin thread</TooltipPopup>
      </Tooltip>
    ) : (
      <PinIcon
        aria-label="Pinned"
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    )
  ) : null;

  const remoteMachineIcon =
    isRemote && !showsScratchMachine ? (
      <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
        <EnvironmentMachineIcon aria-hidden kind={props.environmentMachine} className="size-3.5" />
      </span>
    ) : null;
  const diff = latestRunDiff(thread);
  const classificationBadges = (
    <SidebarThreadClassificationBadges
      workType={thread.workType}
      stage={thread.stage}
      stageManual={thread.stageManual}
      taxonomy={props.harnessTaxonomy}
      onSelect={handleUpdateClassification}
      onResumeStageAuto={handleResumeStageAuto}
    />
  );
  const hasClassification =
    resolveClassificationBadge(props.harnessTaxonomy.workTypes, thread.workType) !== null ||
    resolveClassificationBadge(props.harnessTaxonomy.stages, thread.stage) !== null;
  // Only the trailing identity would remain, so the row moves it to the title line instead.
  const metaLineEmpty =
    !showBranch &&
    !thread.worktreePath?.trim() &&
    !hasClassification &&
    !showsScratchMachine &&
    prBadge === null &&
    diff === null &&
    runningTerminalIds.length === 0;
  const threadTime = <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />;
  // The model name carries the provider, so the glyph earns its place only when
  // two instances of a provider need telling apart or the thread was handed off.
  const providerIdentity = (
    <>
      {remoteMachineIcon}
      {modelLabel ? (
        <span className="min-w-0 shrink truncate text-secondary-label text-xs">{modelLabel}</span>
      ) : null}
      {showInstanceBadge || hasProviderHandoff ? (
        <SidebarProviderStack
          thread={thread}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
        />
      ) : null}
    </>
  );
  // A status took line 1's slot, so the time joins the identity rather than vanish.
  const movedThreadTime =
    (variant === "card" || variant === "cozy") && topStatus ? (
      <span className="tabular-nums text-secondary-label">{threadTime}</span>
    ) : null;
  const metaLine = metaLineEmpty ? null : (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
      {/* A worktree is worth flagging even on a default branch, whose name the row drops. */}
      <ThreadWorktreeIndicator thread={thread} />
      {showBranch && thread.branch ? (
        <span className="flex min-w-0 flex-1">
          <MiddleTruncate value={thread.branch} showTitle={false} />
        </span>
      ) : showsScratchMachine ? (
        <>
          <EnvironmentMachineIcon
            aria-hidden
            kind={props.environmentMachine}
            className="size-3 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{props.scratchMachineLabel}</span>
        </>
      ) : (
        <span className="flex-1" />
      )}
      {classificationBadges}
      {terminalStatusIcon}
      {prBadge}
      {diff ? (
        <span className="shrink-0 font-mono">
          <span className="text-diff-addition-foreground">+{formatDiffCount(diff.insertions)}</span>{" "}
          <span className="text-diff-deletion-foreground">−{formatDiffCount(diff.deletions)}</span>
        </span>
      ) : null}
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
        {providerIdentity}
        {movedThreadTime}
      </span>
    </div>
  );
  const titleLineIcons = metaLineEmpty ? (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {providerIdentity}
      {movedThreadTime}
    </span>
  ) : null;
  // Card and cozy share one status cluster: the status (or time) cross-fades to
  // the hover/focus settle and snooze actions.
  const topLineStatusSlot = (
    <span
      className={cn(
        "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
        props.sweepAction !== null && "hidden",
      )}
    >
      <span
        className={cn(
          isWokeStatus
            ? "pointer-events-auto"
            : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
          "flex items-center self-center justify-self-end tabular-nums text-secondary-label",
          snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
        )}
      >
        {topStatus ? (
          isWokeStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Dismiss Woke notification"
                    onClick={handleAcknowledgeWokeClick}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      topStatus.className,
                    )}
                  >
                    <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                    <span role="status">{topStatus.label}</span>
                  </button>
                }
              />
              <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
            </Tooltip>
          ) : (
            <span className={cn("inline-flex items-center gap-1 font-medium", topStatus.className)}>
              {topStatus.icon ? <TopStatusIcon icon={topStatus.icon} className="size-4" /> : null}
              {/* Not a live region: a collapsed sidebar is inert, so
                BackgroundThreadAnnouncer and the open thread's
                timeline speak status changes instead. */}
              {topStatus.label}
              {status === "working" ? (
                <span aria-hidden>
                  <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                </span>
              ) : status === "waiting" ? (
                <span aria-hidden>
                  <WorkingDuration startedAt={thread.latestRun?.completedAt ?? null} />
                </span>
              ) : null}
            </span>
          )
        ) : (
          threadTime
        )}
      </span>
      {props.settlementSupported || showSnoozeButton || hasUnsentDraft ? (
        <span
          className={cn(
            // Mouse clicks leave Settle focused; focus-within would pin controls over
            // the status label after the pointer leaves. Use focus-visible instead.
            "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
            snoozeMenuOpen && "pointer-events-auto static opacity-100",
          )}
        >
          {hasUnsentDraft ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Discard draft"
                    onClick={handleDiscardDraftClick}
                    className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <XIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Discard draft</TooltipPopup>
            </Tooltip>
          ) : null}
          {showSnoozeButton ? (
            <SnoozeMenuButton
              open={snoozeMenuOpen}
              onOpenChange={setSnoozeMenuOpen}
              onSnooze={handleSnoozePreset}
              timestampFormat={props.timestampFormat}
              environmentId={thread.environmentId}
            />
          ) : null}
          {props.settlementSupported ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Settle thread"
                    onClick={handleSettleClick}
                    onPointerDown={handleActionPointerDown}
                    className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <CheckIcon className="size-3.5" />
                Settle
              </TooltipTrigger>
              <TooltipPopup>Settle thread</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      ) : null}
    </span>
  );

  // Cozy: title and status on line 1; work-type dot, stage pipeline, branch, PR and
  // model on line 2. ~52px tall (h-[3.25rem] + py-0.5).
  if (variant === "cozy") {
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className={cn(
          "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_52px]",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <Tooltip disabled={snoozeMenuOpen || sortable?.isDragging}>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                role="treeitem"
                tabIndex={-1}
                data-sidebar-row={threadKey}
                data-sidebar-parent={props.navigationParent}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-testid="sidebar-row-cozy"
                aria-busy={isRegeneratingTitle || undefined}
                className={rowSurfaceClassName}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {accessibleTitle}
            <div className="relative z-10 flex h-[3.25rem] flex-col justify-center gap-0.5 px-(--sidebar-row-content-inset)">
              <div className="flex h-5 min-w-0 items-center gap-1.5">
                {draftIndicator}
                {props.showProjectIdentity && props.project ? (
                  <ProjectFavicon
                    project={props.project}
                    className="size-4 shrink-0"
                    fallbackIcon={MessageSquareIcon}
                  />
                ) : null}
                {title}
                {isRegeneratingTitle ? (
                  <span role="status" className="sr-only">
                    Regenerating title
                  </span>
                ) : null}
                {pinIndicator}
                {sortable?.isDragging ? dragDestination : topLineStatusSlot}
                {props.sweepAction !== null ? dragDestination : null}
              </div>
              <div className="flex h-4 min-w-0 items-center gap-1.5 text-secondary-label text-xs">
                {classificationBadges}
                <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate whitespace-nowrap">
                  {props.showProjectIdentity && props.projectDisplayName ? (
                    <span className="min-w-0 shrink truncate text-foreground/60">
                      {props.projectDisplayName}
                    </span>
                  ) : null}
                  <ThreadWorktreeIndicator thread={thread} />
                  {showBranch && thread.branch ? (
                    <span className="flex min-w-0 shrink">
                      <MiddleTruncate value={thread.branch} showTitle={false} />
                    </span>
                  ) : showsScratchMachine ? (
                    <>
                      <EnvironmentMachineIcon
                        aria-hidden
                        kind={props.environmentMachine}
                        className="size-3 shrink-0"
                      />
                      <span className="min-w-0 shrink truncate">{props.scratchMachineLabel}</span>
                    </>
                  ) : null}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {providerIdentity}
                  {terminalStatusIcon}
                  {prBadge}
                  {movedThreadTime}
                </span>
              </div>
            </div>
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  if (variant !== "card") {
    const multiline = variant === "folder-multiline";
    const inFolder = variant === "folder" || multiline;
    // Folder rows and compact live rows have no status line, so the status takes
    // the time slot. A PR status is permanent once a thread is linked, so it
    // yields here: the row keeps its time and the badge carries the PR state.
    const statusInTimeSlot = inFolder || variantAction === "settle";
    const slotStatus = statusInTimeSlot && topLineStatusSource !== "pr" ? topStatus : null;
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        {...(fileDropHandlers ?? {})}
        className={cn(
          "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
          metaLine !== null && multiline && "[contain-intrinsic-size:auto_54px]",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <Tooltip disabled={sortable?.isDragging}>
          <TooltipTrigger
            render={
              <div
                ref={rowRef}
                role="treeitem"
                tabIndex={-1}
                data-sidebar-row={threadKey}
                data-sidebar-parent={props.navigationParent}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-testid={inFolder ? "sidebar-row-folder" : "sidebar-row-slim"}
                aria-busy={isRegeneratingTitle || undefined}
                className={cn(
                  rowSurfaceClassName,
                  multiline
                    ? "flex flex-col justify-center px-2.5 py-1.5"
                    : "flex h-9 items-center gap-2.5 px-2.5",
                  // Lines titles up with the folder name, past its chevron and icon.
                  inFolder && "ps-9",
                )}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {/* `contents` keeps one-line rows a single flex row. */}
            <div className={multiline ? "flex h-6 min-w-0 items-center gap-2.5" : "contents"}>
              {accessibleTitle}
              {!inFolder && props.showProjectIdentity && props.project ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center transition-opacity",
                    (!props.isActive || variantAction === "unsettle") &&
                      "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
                  )}
                >
                  <ProjectFavicon
                    project={props.project}
                    className="size-4"
                    fallbackIcon={MessageSquareIcon}
                  />
                </span>
              ) : null}
              {draftIndicator}
              {title}
              {multiline ? titleLineIcons : null}
              {pinIndicator}
              {multiline ? null : terminalStatusIcon}
              {/* One-line rows keep work type only; the fuller rows carry the stage. */}
              {inFolder ? null : (
                <SidebarThreadClassificationBadges
                  workType={thread.workType}
                  stage={thread.stage}
                  stageManual={thread.stageManual}
                  taxonomy={props.harnessTaxonomy}
                  compact
                  onSelect={handleUpdateClassification}
                  onResumeStageAuto={handleResumeStageAuto}
                />
              )}
              {isRegeneratingTitle ? (
                <span role="status" className="sr-only">
                  Regenerating title
                </span>
              ) : null}
              {/* Compact rows have no branch line, so the model is the identity cue left. */}
              {!inFolder && variantAction === "settle" && modelLabel ? (
                <span className="min-w-0 shrink truncate text-secondary-label text-xs">
                  {modelLabel}
                </span>
              ) : null}
              {/* Outside the hover-fading slot: it stays visible and clickable on hover. */}
              {inFolder ? null : prBadge}
              {sortable?.isDragging ? (
                dragDestination
              ) : (
                <span
                  className={cn(
                    "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
                    props.sweepAction !== null && "hidden",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                      !isWoke && "group-any-hover/sidebar-row:opacity-0",
                    )}
                  >
                    {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                      <span className="inline-flex items-center gap-1 text-xs text-info-foreground tabular-nums">
                        {/* The clock tells a wake time from an age at a glance. */}
                        <AlarmClockIcon aria-hidden className="size-3" />
                        {props.snoozeWakeLabelText}
                      </span>
                    ) : (statusInTimeSlot ? isWokeStatus : isWoke) ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label="Dismiss Woke notification"
                              onClick={handleAcknowledgeWokeClick}
                              className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            >
                              <AlarmClockIcon aria-hidden className="size-3" />
                              <span role="status">Woke</span>
                            </button>
                          }
                        />
                        <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                      </Tooltip>
                    ) : slotStatus ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-xs font-medium",
                          slotStatus.className,
                        )}
                      >
                        {slotStatus.icon ? (
                          <TopStatusIcon icon={slotStatus.icon} className="size-3" />
                        ) : null}
                        {slotStatus.label}
                      </span>
                    ) : (
                      <span className="text-xs">
                        <RelativeTimeLabel
                          timestamp={
                            variantAction === "unsettle"
                              ? resolveSettledThreadTimestamp(thread)
                              : threadTimeTimestamp(thread)
                          }
                        />
                      </span>
                    )}
                  </span>
                  {variantAction === "unsnooze" ? (
                    !props.snoozeSupported ? null : (
                      <button
                        type="button"
                        aria-label="Wake thread now"
                        onClick={handleUnsnoozeClick}
                        onPointerDown={handleActionPointerDown}
                        className={cn(
                          "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                          isWoke && "group-any-hover/sidebar-row:static",
                        )}
                      >
                        <AlarmClockOffIcon className="mb-px size-3" />
                      </button>
                    )
                  ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Un-settle thread"
                            onClick={handleUnsettleClick}
                            onPointerDown={handleActionPointerDown}
                            className={cn(
                              "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                              isWoke && "group-any-hover/sidebar-row:static",
                            )}
                          />
                        }
                      >
                        <Undo2Icon className="mb-px size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Un-settle thread</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Settle thread"
                            onClick={handleSettleClick}
                            onPointerDown={handleActionPointerDown}
                            className={cn(
                              "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                              isWoke && "group-any-hover/sidebar-row:static",
                            )}
                          />
                        }
                      >
                        <CheckIcon className="size-3" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Settle thread</TooltipPopup>
                    </Tooltip>
                  )}
                </span>
              )}
              {props.sweepAction !== null ? dragDestination : null}
            </div>
            {multiline ? metaLine : null}
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  return (
    <li
      data-thread-item={threadKey}
      {...sortableRootProps}
      {...(fileDropHandlers ?? {})}
      className={cn(
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]",
        metaLineEmpty && "[contain-intrinsic-size:auto_58px]",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <Tooltip disabled={snoozeMenuOpen || sortable?.isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={rowRef}
              role="treeitem"
              tabIndex={-1}
              data-sidebar-row={threadKey}
              data-sidebar-parent={props.navigationParent}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              data-testid="sidebar-row-card"
              aria-busy={isRegeneratingTitle || undefined}
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {accessibleTitle}
          <div
            className={cn(
              "relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
              metaLineEmpty && "h-auto",
            )}
          >
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              {draftIndicator}
              {props.showProjectIdentity && props.project ? (
                <ProjectFavicon project={props.project} className="size-4 shrink-0" />
              ) : null}
              {/* Left of the status slot, the pin would slide when hover swaps the
                label for the wider row controls. */}
              {pinIndicator}
              {props.showProjectIdentity && props.projectDisplayName ? (
                <span
                  className={cn("min-w-0 flex-1 truncate font-normal text-secondary-label text-xs")}
                >
                  {props.projectDisplayName}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              {sortable?.isDragging ? dragDestination : topLineStatusSlot}
              {props.sweepAction !== null ? dragDestination : null}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              {title}
              {isRegeneratingTitle ? (
                <span role="status" className="sr-only">
                  Regenerating title
                </span>
              ) : null}
              {titleLineIcons}
            </div>
            {metaLine}
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

function latestRunDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  void thread;
  return null;
}

// Attached only to the highlighted result, so React calls it each time the
// highlight lands on a different row: a new query, late rows replacing the first
// result, or arrow keys moving past the scrolled edge.
const scrollHighlightedResultIntoView = (node: HTMLLIElement | null) => {
  node?.scrollIntoView({ block: "nearest" });
};

export const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  /** The query `searchMatch` was found for, which lags `searchQuery` while a search runs. */
  searchMatchQuery?: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const onFileDropThreads = props.onFileDropThreads;
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
  return (
    <li
      ref={props.isHighlighted ? scrollHighlightedResultIntoView : undefined}
      role="presentation"
      className="list-none"
      {...fileDropHandlers}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-describedby={`${props.resultId}-pr`}
              aria-label={accessibility.label}
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className={cn(
                "size-4 shrink-0 transition-opacity",
                props.isSettled &&
                  !props.isRouteActive &&
                  !props.isHighlighted &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  props.isSettled
                    ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                    : "font-medium text-foreground",
                  (props.isHighlighted || props.isRouteActive) && "text-foreground",
                  thread.titleRegeneration != null && "opacity-55",
                )}
              >
                {thread.title}
              </span>
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
                <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchMatchQuery ?? props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});
