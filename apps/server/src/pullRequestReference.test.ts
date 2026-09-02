import { describe, expect, it } from "vite-plus/test";

import { extractPullRequestReference, resolveLinkedRepository } from "./pullRequestReference.ts";

describe("extractPullRequestReference", () => {
  it("matches a canonical GitHub PR URL", () => {
    expect(extractPullRequestReference("https://github.com/owner/repo/pull/42")).toEqual({
      host: "github.com",
      repository: "owner/repo",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
  });

  it("finds a PR URL embedded in prose and strips trailing punctuation", () => {
    const ref = extractPullRequestReference(
      "Opened the pull request at https://github.com/owner/repo/pull/7.",
    );
    expect(ref?.url).toBe("https://github.com/owner/repo/pull/7");
    expect(ref?.number).toBe(7);
  });

  it("recognises a bare gh pr create result line", () => {
    const output = [
      "Creating pull request for feature-branch into main in owner/repo",
      "",
      "https://github.com/owner/repo/pull/128",
    ].join("\n");
    const ref = extractPullRequestReference(output);
    expect(ref?.repository).toBe("owner/repo");
    expect(ref?.number).toBe(128);
  });

  it("returns the last PR URL when several appear", () => {
    const text = [
      "First https://github.com/owner/repo/pull/1",
      "then https://github.com/owner/repo/pull/2",
      "finally https://github.com/owner/repo/pull/3",
    ].join("\n");
    expect(extractPullRequestReference(text)?.number).toBe(3);
  });

  it("handles trailing path, query, and fragment on the URL", () => {
    expect(
      extractPullRequestReference("https://github.com/owner/repo/pull/99/files?w=1#diff")?.number,
    ).toBe(99);
  });

  it("extracts a PR URL from a markdown link", () => {
    const ref = extractPullRequestReference("See [#5](https://github.com/owner/repo/pull/5) now.");
    expect(ref?.url).toBe("https://github.com/owner/repo/pull/5");
  });

  it("lower-cases the repository so matching is case-insensitive", () => {
    expect(extractPullRequestReference("https://github.com/Owner/Repo/pull/12")?.repository).toBe(
      "owner/repo",
    );
  });

  it("recognises a GitHub Enterprise host", () => {
    const ref = extractPullRequestReference("https://github.acme.com/owner/repo/pull/8");
    expect(ref?.host).toBe("github.acme.com");
    expect(ref?.number).toBe(8);
  });

  it("ignores an issues URL", () => {
    expect(extractPullRequestReference("https://github.com/owner/repo/issues/42")).toBeNull();
  });

  it("ignores a commit URL", () => {
    expect(
      extractPullRequestReference("https://github.com/owner/repo/commit/abc123def456"),
    ).toBeNull();
  });

  it("ignores the pull request list route", () => {
    expect(extractPullRequestReference("https://github.com/owner/repo/pulls")).toBeNull();
  });

  it("ignores a non-GitHub host", () => {
    expect(
      extractPullRequestReference("https://gitlab.com/owner/repo/-/merge_requests/3"),
    ).toBeNull();
  });

  it("returns null when there is no PR URL", () => {
    expect(extractPullRequestReference("Nothing to see here, just some text.")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractPullRequestReference("")).toBeNull();
  });
});

describe("resolveLinkedRepository", () => {
  it("uses the detected repository when the project repo is unknown", () => {
    expect(resolveLinkedRepository("owner/repo", null)).toBe("owner/repo");
  });

  it("returns the project's own spelling on a case-insensitive match", () => {
    expect(resolveLinkedRepository("owner/repo", "Owner/Repo")).toBe("Owner/Repo");
  });

  it("drops a detection whose repo differs from a known project repo", () => {
    expect(resolveLinkedRepository("someone/else", "owner/repo")).toBeNull();
  });
});
