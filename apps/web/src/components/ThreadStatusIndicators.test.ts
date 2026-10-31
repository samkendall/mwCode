import { SourceControlProviderKind } from "@t3tools/contracts";
import { ProjectId, type PullRequestSummary, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { PullRequestCheck, PullRequestCheckStatus } from "@t3tools/contracts";
import {
  linkedPullRequestSnapshotStatus,
  prBadgePresentation,
  resolveDisplayedThreadPr,
  resolveDisplayedThreadPrProvider,
  resolvePrReviewStatus,
  rollupPrChecksState,
  settledPrHoverColorClass,
} from "./ThreadStatusIndicators";
import { newestPullRequestSummary } from "../state/pullRequests";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

function mergedFeaturePr(): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    baseRef: "main",
    headRef: "feature/current",
    state: "merged",
  };
}

function pullRequestSummary(
  state: PullRequestSummary["state"],
  updatedAt: string,
): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    title: "Feature PR",
    url: "https://github.com/pingdotgg/t3code/pull/42",
    state,
    headBranch: "feature/current",
    baseBranch: "main",
    updatedAt,
  };
}

describe("shared pull request state", () => {
  it("never lets a stale open response regress a merged observation", () => {
    const merged = pullRequestSummary("merged", "2026-09-03T01:01:00.000Z");
    const staleOpen = pullRequestSummary("open", "2026-09-03T01:00:00.000Z");

    expect(newestPullRequestSummary(merged, staleOpen)).toBe(merged);
  });

  it("accepts a newer open state after a closed pull request is reopened", () => {
    const closed = pullRequestSummary("closed", "2026-09-03T01:00:00.000Z");
    const reopened = pullRequestSummary("open", "2026-09-03T01:01:00.000Z");

    expect(newestPullRequestSummary(closed, reopened)).toBe(reopened);
  });
});

describe("resolveDisplayedThreadPr", () => {
  const featureBranch = "feature/current";
  const mergedPr = mergedFeaturePr();
  const linkedPullRequest = {
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
  };
  const provider = {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  };

  it("shows a linked pull request when the checkout has a different branch", () => {
    const input = {
      threadBranch: "feature/other",
      gitStatus: status({ refName: "feature/other", pr: null }),
      linkedPullRequest,
      linkedPullRequestStatus: { pr: mergedPr, sourceControlProvider: provider },
    };

    expect(resolveDisplayedThreadPr(input)).toEqual(mergedPr);
    expect(resolveDisplayedThreadPrProvider(input)).toEqual(provider);
  });

  it("never attaches a PR reported by main to the feature thread", () => {
    const mainPr = {
      number: 99,
      title: "Unrelated main PR",
      url: "https://github.com/pingdotgg/t3code/pull/99",
      baseRef: "develop",
      headRef: "main",
      state: "merged" as const,
    };
    expect(
      resolveDisplayedThreadPr({
        threadBranch: featureBranch,
        gitStatus: status({ refName: "main", pr: mainPr }),
      }),
    ).toBeNull();
  });
});

describe("linkedPullRequestSnapshotStatus", () => {
  it("carries the snapshot's review verdict to the badge without another read", () => {
    const result = linkedPullRequestSnapshotStatus({
      host: "github.com",
      repository: "pingdotgg/t3code",
      number: 42,
      url: "https://github.com/pingdotgg/t3code/pull/42",
      source: "manual",
      linkedAt: "2026-01-01T00:00:00Z",
      stack: null,
      snapshot: {
        state: "open",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00Z",
        syncedAt: "2026-01-03T00:00:00Z",
        reviewDecision: "changes-requested",
        checksState: "failing",
        mergeability: "conflicting",
      },
    });
    expect(result?.signals).toEqual({
      isDraft: false,
      reviewDecision: "changes-requested",
      checksState: "failing",
      mergeability: "conflicting",
    });
  });
});

describe("rollupPrChecksState", () => {
  function check(status: PullRequestCheckStatus): PullRequestCheck {
    return { name: `check-${status}`, status, description: null, url: null };
  }

  it("reports nothing for a PR with no checks", () => {
    expect(rollupPrChecksState([])).toBeNull();
  });

  it("is failing when any check failed or was cancelled", () => {
    expect(rollupPrChecksState([check("success"), check("failure")])).toBe("failing");
    expect(rollupPrChecksState([check("success"), check("cancelled")])).toBe("failing");
  });

  it("is pending when a check is still running and none failed", () => {
    expect(rollupPrChecksState([check("success"), check("pending")])).toBe("pending");
  });

  it("failing outranks pending", () => {
    expect(rollupPrChecksState([check("pending"), check("failure")])).toBe("failing");
  });

  it("is passing when every check settled without failure", () => {
    expect(rollupPrChecksState([check("success"), check("skipped"), check("neutral")])).toBe(
      "passing",
    );
  });
});

describe("prBadgePresentation", () => {
  it("shows merged and closed from state alone (branch-matched PRs have no signals)", () => {
    expect(prBadgePresentation("merged")).toMatchObject({ tone: "merged", statusLabel: "Merged" });
    expect(prBadgePresentation("merged").colorClass).toContain("text-violet-600");
    expect(prBadgePresentation("closed")).toMatchObject({ tone: "closed", statusLabel: "Closed" });
    expect(prBadgePresentation("closed").colorClass).toContain("text-red-600");
  });

  it("keeps a signalless open PR neutral", () => {
    expect(prBadgePresentation("open")).toMatchObject({ tone: "pending", statusLabel: "Open" });
    expect(prBadgePresentation("open").colorClass).toContain("text-sky-600");
  });

  it("marks a draft PR as such", () => {
    expect(prBadgePresentation("open", { isDraft: true })).toMatchObject({
      tone: "draft",
      statusLabel: "Draft",
    });
  });

  it("flags failing checks as attention", () => {
    expect(prBadgePresentation("open", { checksState: "failing" })).toMatchObject({
      tone: "attention",
      statusLabel: "Checks failing",
    });
    expect(prBadgePresentation("open", { checksState: "failing" }).colorClass).toContain(
      "text-red-600",
    );
  });

  it("flags requested changes as attention", () => {
    expect(prBadgePresentation("open", { reviewDecision: "changes-requested" })).toMatchObject({
      tone: "attention",
      statusLabel: "Changes requested",
    });
  });

  it("warns on merge conflicts", () => {
    expect(prBadgePresentation("open", { mergeability: "conflicting" })).toMatchObject({
      tone: "warning",
      statusLabel: "Merge conflicts",
    });
    expect(prBadgePresentation("open", { mergeability: "conflicting" }).colorClass).toContain(
      "text-amber-600",
    );
  });

  it("shows approval as ready", () => {
    expect(prBadgePresentation("open", { reviewDecision: "approved" })).toMatchObject({
      tone: "ready",
      statusLabel: "Approved",
    });
    expect(prBadgePresentation("open", { reviewDecision: "approved" }).colorClass).toContain(
      "text-emerald-600",
    );
  });

  it("treats a mergeable, green PR as ready to merge", () => {
    expect(
      prBadgePresentation("open", { mergeability: "mergeable", checksState: "passing" }),
    ).toMatchObject({ tone: "ready", statusLabel: "Ready to merge" });
  });

  it("does not call a review-required PR ready even when green", () => {
    expect(
      prBadgePresentation("open", {
        mergeability: "mergeable",
        checksState: "passing",
        reviewDecision: "review-required",
      }),
    ).toMatchObject({ tone: "pending", statusLabel: "Review required" });
  });

  it("surfaces an armed auto-merge", () => {
    expect(prBadgePresentation("open", { autoMergeEnabled: true })).toMatchObject({
      tone: "auto-merge",
      statusLabel: "Auto-merge armed",
    });
    expect(prBadgePresentation("open", { autoMergeEnabled: true }).colorClass).toContain(
      "text-indigo-600",
    );
  });

  it("lets a blocking signal win over a ready one", () => {
    expect(
      prBadgePresentation("open", {
        mergeability: "mergeable",
        checksState: "failing",
        reviewDecision: "approved",
      }),
    ).toMatchObject({ tone: "attention", statusLabel: "Checks failing" });
    expect(
      prBadgePresentation("open", {
        mergeability: "mergeable",
        checksState: "passing",
        reviewDecision: "changes-requested",
      }),
    ).toMatchObject({ tone: "attention", statusLabel: "Changes requested" });
  });
});

describe("resolvePrReviewStatus", () => {
  const openPr = (): NonNullable<VcsStatusResult["pr"]> => ({
    ...mergedFeaturePr(),
    state: "open",
  });

  it("returns null when there is no PR", () => {
    expect(resolvePrReviewStatus(null)).toBeNull();
  });

  it("reads a merged PR as Merged in violet", () => {
    const result = resolvePrReviewStatus(mergedFeaturePr());
    expect(result).toMatchObject({ label: "Merged", tone: "merged" });
    expect(result?.colorClass).toContain("text-violet-600");
  });

  it("reads a closed-unmerged PR as Closed in red, distinct from merged", () => {
    const result = resolvePrReviewStatus({ ...mergedFeaturePr(), state: "closed" });
    expect(result).toMatchObject({ label: "Closed", tone: "closed" });
    expect(result?.colorClass).toContain("text-red-600");
  });

  it("reads changes-requested as Changes requested in red", () => {
    const result = resolvePrReviewStatus(openPr(), { reviewDecision: "changes-requested" });
    expect(result).toMatchObject({ label: "Changes requested", tone: "attention" });
    expect(result?.colorClass).toContain("text-red-600");
  });

  it("reads an approved PR as Ready to merge in green", () => {
    const result = resolvePrReviewStatus(openPr(), { reviewDecision: "approved" });
    expect(result).toMatchObject({ label: "Ready to merge", tone: "ready" });
    expect(result?.colorClass).toContain("text-emerald-600");
  });

  it("reads a review-required PR as Awaiting review", () => {
    expect(resolvePrReviewStatus(openPr(), { reviewDecision: "review-required" })).toMatchObject({
      label: "Awaiting review",
      tone: "pending",
    });
  });

  it("reads an open PR with no decision yet as Awaiting review", () => {
    expect(resolvePrReviewStatus(openPr())).toMatchObject({
      label: "Awaiting review",
      tone: "pending",
    });
  });

  it("shares the badge's tone so status and badge never disagree", () => {
    const signals = { mergeability: "conflicting" as const };
    expect(resolvePrReviewStatus(openPr(), signals)?.tone).toBe(
      prBadgePresentation("open", signals).tone,
    );
  });
});

describe("settledPrHoverColorClass", () => {
  it.each([
    ["open", "text-emerald-600"],
    ["merged", "text-violet-600"],
    ["closed", "text-red-600"],
  ] as const)("restores the %s pull request color on row hover", (state, colorClass) => {
    expect(settledPrHoverColorClass(state)).toContain(`group-hover/sidebar-row:${colorClass}`);
  });

  it("keeps draft pull requests gray on row hover", () => {
    expect(settledPrHoverColorClass("draft")).toContain("group-hover/sidebar-row:text-zinc-500");
  });
});
