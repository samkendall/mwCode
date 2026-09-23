import { ProjectId, type PullRequestSummary, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type { PullRequestCheck, PullRequestCheckStatus } from "@t3tools/contracts";
import {
  ChangeRequestStatusIcon,
  prBadgePresentation,
  prStatusIndicator,
  resolvePrReviewStatus,
  resolveThreadPullRequestBadgePresentation,
  rollupPrChecksState,
  settledPrHoverColorClass,
} from "./ThreadStatusIndicators";
import { newestPullRequestSummary } from "../state/pullRequests";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

describe("ChangeRequestStatusIcon", () => {
  it.each([
    ["open", "open", false, PullRequestGlyph.pullRequest],
    ["draft", "open", true, PullRequestGlyph.draft],
    ["closed", "closed", false, PullRequestGlyph.closed],
    ["merged", "merged", false, PullRequestGlyph.merged],
  ] as const)("uses the %s pull request glyph", (_label, state, isDraft, expectedIcon) => {
    expect(ChangeRequestStatusIcon({ state, isDraft }).type).toBe(expectedIcon);
  });
});

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

function pullRequestSummary(
  state: PullRequestSummary["state"],
  updatedAt: string,
): PullRequestSummary {
  return {
    provider: "github",
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
  it("shows a panel-observed merge instead of an older sidebar summary", () => {
    const open = pullRequestSummary("open", "2026-09-03T01:00:00.000Z");
    const merged = pullRequestSummary("merged", "2026-09-03T01:01:00.000Z");

    expect(newestPullRequestSummary(open, merged)).toBe(merged);
  });

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

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses red for closed pull requests", () => {
    const closedPr = status().pr;
    if (!closedPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...closedPr, state: "closed" }, undefined)?.colorClass).toContain(
      "text-red-600",
    );
  });

  it("uses gray and draft wording for draft pull requests", () => {
    const draftPr = status().pr;
    if (!draftPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...draftPr, isDraft: true }, undefined)).toMatchObject({
      label: "PR draft",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltipLead: "PR #42 - Draft",
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

describe("resolveThreadPullRequestBadgePresentation", () => {
  const url = "https://github.com/pingdotgg/t3code/pull/42";

  it("returns the pending pull-request badge when no snapshot is available", () => {
    expect(
      resolveThreadPullRequestBadgePresentation({
        badge: null,
        number: 42,
        url,
        status: null,
      }),
    ).toEqual({
      Icon: PullRequestGlyph.pullRequest,
      toneClassName: "text-muted-foreground",
      label: "PR #42, status pending",
      text: 42,
    });
  });

  it.each([
    [
      "open",
      { state: "open", isDraft: false },
      PullRequestGlyph.pullRequest,
      "text-emerald-600 dark:text-emerald-300/90",
      "PR #42 - Open: PR branch",
    ],
    [
      "draft",
      { state: "open", isDraft: true },
      PullRequestGlyph.draft,
      "text-zinc-500 dark:text-zinc-400/80",
      "PR #42 - Draft: PR branch",
    ],
    [
      "closed",
      { state: "closed", isDraft: false },
      PullRequestGlyph.closed,
      "text-red-600 dark:text-red-300/90",
      "PR #42 - Closed: PR branch",
    ],
    [
      "merged",
      { state: "merged", isDraft: false },
      PullRequestGlyph.merged,
      "text-violet-600 dark:text-violet-300/90",
      "PR #42 - Merged: PR branch",
    ],
  ] as const)(
    "keeps the %s state for one linked pull request",
    (_state, prOverrides, expectedIcon, expectedToneClassName, expectedLabel) => {
      const fixture = status().pr;
      if (!fixture) throw new Error("Expected pull request fixture");
      const prStatus = prStatusIndicator({ ...fixture, ...prOverrides }, undefined);
      if (!prStatus) throw new Error("Expected pull request status");

      expect(
        resolveThreadPullRequestBadgePresentation({
          badge: { kind: "pull-request", others: 0, state: "open" },
          number: fixture.number,
          url: fixture.url,
          status: prStatus,
        }),
      ).toEqual({
        Icon: expectedIcon,
        toneClassName: expectedToneClassName,
        label: expectedLabel,
        text: fixture.number,
      });
    },
  );

  it.each([
    ["open", "text-emerald-600 dark:text-emerald-300/90"],
    ["draft", "text-zinc-500 dark:text-zinc-400/80"],
    ["merged", "text-violet-600 dark:text-violet-300/90"],
  ] as const)(
    "uses a layers badge with the %s stack tone without a link identity",
    (state, expectedToneClassName) => {
      expect(
        resolveThreadPullRequestBadgePresentation({
          badge: { kind: "stack", layers: 3, state },
          status: null,
        }),
      ).toEqual({
        Icon: PullRequestGlyph.stack,
        toneClassName: expectedToneClassName,
        label: `Stack of 3 pull requests, ${state}`,
        text: 3,
      });
    },
  );

  it.each([
    ["open", PullRequestGlyph.pullRequest, "text-emerald-600 dark:text-emerald-300/90"],
    ["draft", PullRequestGlyph.draft, "text-zinc-500 dark:text-zinc-400/80"],
    ["merged", PullRequestGlyph.merged, "text-violet-600 dark:text-violet-300/90"],
  ] as const)(
    "draws the count of unrelated linked pull requests with their %s aggregate state",
    (state, expectedIcon, expectedToneClassName) => {
      const fixture = status().pr;
      if (!fixture) throw new Error("Expected pull request fixture");
      const closedStatus = prStatusIndicator(
        { ...fixture, state: "closed", isDraft: false },
        undefined,
      );
      if (!closedStatus) throw new Error("Expected pull request status");

      expect(
        resolveThreadPullRequestBadgePresentation({
          badge: { kind: "pull-request", others: 2, state },
          number: fixture.number,
          url: fixture.url,
          status: closedStatus,
        }),
      ).toEqual({
        Icon: expectedIcon,
        toneClassName: expectedToneClassName,
        label: `PR #42 - Closed: PR branch, and 2 more linked; overall ${state}`,
        text: "+3",
      });
    },
  );

  it("omits the control when neither a stack nor a linked identity can be shown", () => {
    expect(resolveThreadPullRequestBadgePresentation({ badge: null, status: null })).toBeNull();
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
    expect(settledPrHoverColorClass("open", true)).toContain(
      "group-hover/sidebar-row:text-zinc-500",
    );
  });
});
