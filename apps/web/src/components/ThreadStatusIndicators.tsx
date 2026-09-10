import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pullRequestDetailToVcsStatus } from "@t3tools/client-runtime/state/pull-requests";
import {
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestMergeability,
  type PullRequestReviewDecision,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";
import { FolderGit2Icon, GitPullRequestArrowIcon, LayersIcon, TerminalIcon } from "lucide-react";
import { useMemo, type MouseEvent } from "react";
import { buttonVariants, InlineButton } from "./ui/button";
import { cn } from "../lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { parseChangeRequestUrl } from "../lib/openPullRequestLink";
import { useEnvironmentQuery } from "../state/query";
import { linkedPullRequestDetailAtom, useSharedPullRequestSummary } from "../state/pullRequests";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { pullRequestListLines } from "./pullRequest/pullRequestListLines";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  tooltipLead: string;
  tooltipTitle: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

/**
 * The review/merge signals the sidebar reflects on an open PR's badge, distilled from the linked
 * PR detail the row already polls — including the host's rolled-up `reviewDecision`, so the
 * approved/changes-requested/review-required states render from the same detail as the rest.
 */
export interface PrBadgeReviewSignals {
  readonly isDraft?: boolean;
  readonly reviewDecision?: PullRequestReviewDecision | null;
  readonly checksState?: PullRequestChecksState | null;
  readonly mergeability?: PullRequestMergeability | null;
  readonly autoMergeEnabled?: boolean;
}

export interface LinkedThreadPullRequestStatus {
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: NonNullable<VcsStatusResult["sourceControlProvider"]>;
  /** Distilled from the same polled detail — no extra fetch. Absent only for legacy call sites. */
  readonly signals?: PrBadgeReviewSignals;
}

/**
 * The one-glyph rollup of a PR's checks, from the individual checks the detail carries. A single
 * failing or cancelled run makes the whole PR "failing"; an outstanding run makes it "pending";
 * everything else (success, skipped, neutral) is "passing". `null` when the PR has no checks at
 * all, which reads as "nothing to report" rather than a green tick.
 */
export function rollupPrChecksState(
  checks: ReadonlyArray<PullRequestCheck>,
): PullRequestChecksState | null {
  if (checks.length === 0) return null;
  let sawPending = false;
  for (const check of checks) {
    if (check.status === "failure" || check.status === "cancelled") return "failing";
    if (check.status === "pending") sawPending = true;
  }
  return sawPending ? "pending" : "passing";
}

/**
 * Which shade a PR badge wears. Only "merged"/"closed" are reachable for a branch-matched PR (no
 * detail); the rest need the linked-PR signals. Ordered by what a reviewer needs to see first:
 * something blocking beats something ready.
 */
export type PrBadgeTone =
  | "merged"
  | "closed"
  | "attention"
  | "warning"
  | "ready"
  | "auto-merge"
  | "pending"
  | "draft";

export interface PrBadgePresentation {
  readonly tone: PrBadgeTone;
  /** Static text color; no hover/animation, safe for a dense row. */
  readonly colorClass: string;
  /** A short status word for the badge's accessible label and tooltip. */
  readonly statusLabel: string;
}

const PR_BADGE_COLOR: Record<PrBadgeTone, string> = {
  merged: "text-violet-600 dark:text-violet-300/90",
  closed: "text-red-600 dark:text-red-300/90",
  attention: "text-red-600 dark:text-red-300/90",
  warning: "text-amber-600 dark:text-amber-300/90",
  ready: "text-emerald-600 dark:text-emerald-300/90",
  "auto-merge": "text-indigo-600 dark:text-indigo-300/90",
  pending: "text-sky-600 dark:text-sky-300/90",
  draft: "text-muted-foreground",
};

function prBadge(tone: PrBadgeTone, statusLabel: string): PrBadgePresentation {
  return { tone, colorClass: PR_BADGE_COLOR[tone], statusLabel };
}

/**
 * Maps a PR's state plus (for a linked PR) its review/merge signals to a single badge shade and a
 * word for the label. The `state` alone is always enough — that is the branch-matched fallback —
 * and richer `signals` sharpen an open PR into "ready to merge", "changes requested", "checks
 * failing", and so on so the sidebar shows at a glance what is waiting.
 */
export function prBadgePresentation(
  state: NonNullable<ThreadPr>["state"],
  signals?: PrBadgeReviewSignals,
): PrBadgePresentation {
  if (state === "merged") return prBadge("merged", "Merged");
  if (state === "closed") return prBadge("closed", "Closed");

  const isDraft = signals?.isDraft ?? false;
  const reviewDecision = signals?.reviewDecision ?? null;
  const checksState = signals?.checksState ?? null;
  const mergeability = signals?.mergeability ?? null;
  const autoMergeEnabled = signals?.autoMergeEnabled ?? false;

  if (isDraft) return prBadge("draft", "Draft");
  if (checksState === "failing") return prBadge("attention", "Checks failing");
  if (reviewDecision === "changes-requested") return prBadge("attention", "Changes requested");
  if (mergeability === "conflicting") return prBadge("warning", "Merge conflicts");
  if (reviewDecision === "approved") return prBadge("ready", "Approved");
  if (
    mergeability === "mergeable" &&
    checksState === "passing" &&
    reviewDecision !== "review-required"
  ) {
    return prBadge("ready", "Ready to merge");
  }
  if (autoMergeEnabled) return prBadge("auto-merge", "Auto-merge armed");
  if (reviewDecision === "review-required") return prBadge("pending", "Review required");
  return prBadge("pending", "Open");
}

export interface PrReviewRowStatus {
  /** The word the row's line-1 status slot shows, e.g. "Awaiting review". */
  readonly label: string;
  readonly tone: PrBadgeTone;
  /** Static text color shared with the badge so the two never disagree. */
  readonly colorClass: string;
}

// The row status spells the PR state in words, coarser than the badge's own
// label. Only these three badge labels get re-worded for the row; every other
// badge label (Merged, Changes requested, Checks failing, Merge conflicts,
// Draft, Auto-merge armed, Closed) reads the same in both places.
const PR_REVIEW_ROW_LABEL: Record<string, string> = {
  Approved: "Ready to merge",
  "Review required": "Awaiting review",
  Open: "Awaiting review",
};

/**
 * The PR review/merge state to promote into a thread row's line-1 status slot,
 * derived from the SAME `prBadgePresentation` mapping the badge uses so the two
 * can never disagree on tone. `null` only when the thread has no PR at all.
 * Open PRs read "Awaiting review" / "Changes requested" / "Ready to merge";
 * terminal PRs read "Merged" / "Closed".
 */
export function resolvePrReviewStatus(
  pr: ThreadPr,
  signals?: PrBadgeReviewSignals,
): PrReviewRowStatus | null {
  if (!pr) return null;
  const presentation = prBadgePresentation(pr.state, signals);
  return {
    label: PR_REVIEW_ROW_LABEL[presentation.statusLabel] ?? presentation.statusLabel,
    tone: presentation.tone,
    colorClass: presentation.colorClass,
  };
}

/** Linked badges use persisted snapshots; only branch and legacy fallbacks lease summary reads. */
export function useLinkedThreadPullRequest(
  environmentId: EnvironmentId | null,
  linkedPullRequest: ThreadLinkedPullRequest | null | undefined,
  enabled = true,
  pullRequests?: ReadonlyArray<ThreadPullRequestLink>,
  branchPullRequest?: ThreadLinkedPullRequest | null,
): LinkedThreadPullRequestStatus | null {
  const supportsLinks = useSupportsMultiplePullRequests(environmentId);
  const current = useMemo(
    () => (supportsLinks ? resolveThreadCurrentPullRequestLink(pullRequests ?? []) : null),
    [pullRequests, supportsLinks],
  );
  const fallback =
    current === null ? ((!supportsLinks ? linkedPullRequest : null) ?? branchPullRequest) : null;
  const host = fallback == null ? undefined : parseChangeRequestUrl(fallback.url)?.host;
  const reference =
    fallback == null ? null : { ...fallback, ...(host === undefined ? {} : { host }) };
  const queried = useEnvironmentQuery(
    !enabled || environmentId === null || reference === null
      ? null
      : linkedPullRequestDetailAtom({ environmentId, input: reference }),
  ).data;
  const detail = useSharedPullRequestSummary(environmentId, reference, queried);

  return useMemo(() => {
    if (current !== null) return linkedPullRequestSnapshotStatus(current);
    return detail === null
      ? null
      : {
          pr: pullRequestDetailToVcsStatus(detail),
          sourceControlProvider: { kind: detail.provider, name: detail.provider, baseUrl: "" },
          // The linked-thread poll reads the light summary, not the full detail, so only the
          // signals that ride along on that one read are available here. Checks, mergeability,
          // and auto-merge stay behind the detail view; the badge degrades to state + review.
          signals: {
            isDraft: detail.isDraft ?? false,
            // The host's rolled-up review verdict, absent where it does not summarise reviews or
            // has none yet — the badge then falls back to the state alone.
            reviewDecision: detail.reviewDecision ?? null,
          },
        };
  }, [current, detail]);
}

export function linkedPullRequestSnapshotStatus(
  link: ThreadPullRequestLink,
): LinkedThreadPullRequestStatus | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return null;
  const kind = link.url.includes("/-/merge_requests/")
    ? "gitlab"
    : link.url.includes("/pullrequest/")
      ? "azure-devops"
      : link.url.includes("/pull-requests/")
        ? "bitbucket"
        : "github";
  return {
    pr: {
      number: link.number,
      url: link.url,
      title: snapshot.title,
      state: snapshot.state,
      isDraft: snapshot.isDraft,
      headRef: snapshot.headBranch,
      baseRef: snapshot.baseBranch,
      ...(snapshot.updatedAt === null ? {} : { updatedAt: snapshot.updatedAt }),
    },
    sourceControlProvider: { kind, name: kind, baseUrl: "" },
    // The persisted snapshot already carries the review/check rollups the badge
    // sharpens an open PR with, so the row reads them without any extra poll.
    signals: {
      isDraft: snapshot.isDraft,
      reviewDecision: snapshot.reviewDecision ?? null,
      checksState: snapshot.checksState ?? null,
      mergeability: snapshot.mergeability ?? null,
    },
  };
}

export {
  resolveThreadPullRequestBadge,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";

/** The glyph a row's badge wears: the layers icon for a stack, the pull-request one otherwise. */
function ThreadPullRequestBadgeIcon({
  icon,
  className,
}: {
  icon: "stack" | "pull-request";
  className?: string | undefined;
}) {
  const Icon = icon === "stack" ? LayersIcon : GitPullRequestArrowIcon;
  return <Icon aria-hidden className={cn("size-3 shrink-0", className)} />;
}

/** The complete linked-PR control shared by the sidebar and composer footer. */
export function ThreadPullRequestBadgeControl({
  variant,
  badge,
  number,
  url,
  status,
  onOpenStack,
  onOpenPullRequest,
}: {
  variant: "underline" | "ghost";
  badge: ThreadPullRequestBadge | null;
  number?: number | undefined;
  url?: string | undefined;
  status: PrStatusIndicator | null;
  onOpenStack: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const isStack = badge?.kind === "stack";
  if (!isStack && (number === undefined || url === undefined)) return null;
  const label = isStack
    ? `Stack of ${badge.layers} pull requests, ${badge.state}`
    : `${status?.tooltip ?? `PR #${number}, status pending`}${
        badge?.kind === "pull-request" && badge.others > 0
          ? `, and ${badge.others} more linked`
          : ""
      }`;
  const className = cn(
    variant === "ghost"
      ? buttonVariants({ variant: "ghost", size: "xs" })
      : "inline-flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap border-b border-transparent hover:border-current focus-visible:outline-2 focus-visible:outline-ring",
    "text-xs tabular-nums",
    variant === "ghost" &&
      "font-normal text-xs! active:scale-100 [--control-icon-color:currentColor]",
    isStack ? PR_STATE_COLOR_CLASS[badge.state] : (status?.colorClass ?? "text-muted-foreground"),
  );
  const content = (
    <>
      <ThreadPullRequestBadgeIcon icon={badge?.kind ?? "pull-request"} />
      {isStack ? badge.layers : number}
      {badge?.kind === "pull-request" && badge.others > 0 ? (
        <span className="opacity-70">+{badge.others}</span>
      ) : null}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          isStack ? (
            <InlineButton
              className={className}
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenStack();
              }}
            />
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenPullRequest}
            />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A miniature of the pull-requests panel for the thread tooltip: same order, same indentation,
 * so the hover answers "what is in here" without opening the surface.
 */
export function ThreadPullRequestsMiniList({
  pullRequests,
}: {
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}) {
  const lines = useMemo(
    () =>
      pullRequestListLines(resolveThreadPullRequestChains(visibleThreadPullRequests(pullRequests))),
    [pullRequests],
  );
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((line) => {
        const snapshot = line.link.snapshot;
        const presentation =
          snapshot === null
            ? null
            : resolvePullRequestState({ state: snapshot.state, isDraft: snapshot.isDraft });
        return (
          <li
            key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
            className="flex min-w-0 items-center gap-2"
            // Capped like the panel: past a few layers the indent only repeats "still in the
            // stack", and sixteen of them would walk the titles off the popover.
            style={{ paddingLeft: `${Math.min(line.depth, 3) * 0.75}rem` }}
          >
            {presentation ? (
              <presentation.Icon
                aria-hidden
                className={cn("size-3 shrink-0", presentation.toneClassName)}
              />
            ) : (
              <GitPullRequestArrowIcon
                aria-hidden
                className="size-3 shrink-0 stroke-muted-foreground"
              />
            )}
            <span className="shrink-0 font-mono tabular-nums">#{line.link.number}</span>
            <span className="min-w-0 truncate text-foreground/75">
              {snapshot?.title ?? line.link.repository}
            </span>
            {line.stack ? (
              <span className="ml-auto shrink-0 pl-1 text-[10px]">
                {line.stack.kind === "native" ? "stack" : "chain"} · {line.stack.size}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The ink each pull-request state wears in the sidebar, shared by the number and stack badges. */
const PR_STATE_COLOR_CLASS: Record<NonNullable<ThreadPr>["state"], string> = {
  open: "text-emerald-600 dark:text-emerald-300/90",
  merged: "text-violet-600 dark:text-violet-300/90",
  closed: "text-red-600 dark:text-red-300/90",
};

export function settledPrHoverColorClass(
  state: NonNullable<ThreadPr>["state"],
  isDraft = false,
): string {
  switch (state) {
    case "open":
      if (isDraft) {
        return "group-hover/sidebar-row:text-zinc-500 dark:group-hover/sidebar-row:text-zinc-400/80";
      }
      return "group-hover/sidebar-row:text-emerald-600 dark:group-hover/sidebar-row:text-emerald-300/90";
    case "merged":
      return "group-hover/sidebar-row:text-violet-600 dark:group-hover/sidebar-row:text-violet-300/90";
    case "closed":
      return "group-hover/sidebar-row:text-red-600 dark:group-hover/sidebar-row:text-red-300/90";
  }
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  function formatPrState(pr: NonNullable<ThreadPr>): string {
    if (pr.state === "open" && pr.isDraft === true) return "Draft";
    return pr.state.charAt(0).toUpperCase() + pr.state.slice(1);
  }

  function formatPrStatusLead(pr: NonNullable<ThreadPr>, changeRequestShortName: string): string {
    return `${changeRequestShortName} #${pr.number} - ${formatPrState(pr)}`;
  }
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  const tooltipLead = formatPrStatusLead(pr, presentation.shortName);
  const tooltip = `${tooltipLead}: ${pr.title}`;

  if (pr.state === "open") {
    const isDraft = pr.isDraft === true;
    return {
      label: `${presentation.shortName} ${isDraft ? "draft" : "open"}`,
      colorClass: isDraft
        ? "text-zinc-500 dark:text-zinc-400/80"
        : "text-emerald-600 dark:text-emerald-300/90",
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-red-600 dark:text-red-300/90",
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip,
      tooltipLead,
      tooltipTitle: pr.title,
      url: pr.url,
    };
  }
  return null;
}

export function ChangeRequestStatusIcon({
  state,
  isDraft = false,
  className,
}: Pick<NonNullable<ThreadPr>, "state"> & {
  readonly isDraft?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const presentation = resolvePullRequestState({ state, isDraft });
  return <presentation.Icon className={className} />;
}

export function PrStatusTooltipContent({ status }: { status: PrStatusIndicator }) {
  return (
    <span className="flex max-w-[min(34rem,calc(100vw-2rem))] items-stretch overflow-hidden whitespace-nowrap">
      <span className="shrink-0 pr-2 font-medium">{status.tooltipLead}</span>
      <span className="min-h-4 shrink-0 border-border/70 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate pl-2">{status.tooltipTitle}</span>
    </span>
  );
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const pullRequest = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    true,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = pullRequest?.pr ?? null;
  const prStatus = prStatusIndicator(pr, pullRequest?.sourceControlProvider);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const pendingLink =
    pr === null && supportsMultiplePullRequests
      ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
      : null;
  if (!prStatus && !threadStatus && !pendingLink) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus && pr ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon state={pr.state} isDraft={pr.isDraft} className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <PrStatusTooltipContent status={prStatus} />
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {pendingLink ? (
        <GitPullRequestArrowIcon
          className="size-3 text-muted-foreground"
          aria-label={`PR #${pendingLink.number}, status pending`}
        />
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // No primary (the hosted app) means every thread is remote, and the machine
  // glyph is what tells the environments apart.
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? "Remote") : null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <EnvironmentMachineIcon
              kind={remoteMachine}
              className="size-3 text-muted-foreground/60"
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
