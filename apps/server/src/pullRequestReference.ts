/**
 * Pure, IO-free detection of a GitHub pull request URL inside free text.
 *
 * The user's sessions carry the PR even when T3 Code's own PR-linking UI is
 * never used: the agent runs `gh pr create` (whose result line is the bare
 * URL) or otherwise writes a PR URL into its reply. {@link
 * extractPullRequestReference} finds that URL so the reactor can set
 * `thread.linkedPullRequest`, which lights up the existing PR-detail poll and
 * review decision with no other change.
 *
 * Deliberately conservative:
 *   - Only github.com (and its subdomains, e.g. `www.github.com`) is in scope
 *     for v1. GitLab / Bitbucket / Azure are left out; the caller only needs
 *     GitHub today and a wrong host is worse than no match. GitHub Enterprise
 *     uses arbitrary customer domains we cannot infer from spelling, so it is
 *     unsupported for now rather than guessed at (a `github.<x>` prefix would
 *     also match lookalikes like `github.evil.com`).
 *   - Only the `/pull/<n>` shape counts. `/issues/<n>`, `/commit/<sha>`,
 *     `/pulls`, a repository root and the rest are ignored because they carry
 *     no PR the poll could read.
 *   - The LAST match in the text wins: a session that touched several PRs is
 *     most likely linking the one it just created or referenced.
 *
 * @module PullRequestReference
 */

export interface PullRequestReference {
  /** The lower-cased host the PR is addressed below (`github.com`, an install). */
  readonly host: string;
  /** `owner/repo`, lower-cased, as GitHub treats both case-insensitively. */
  readonly repository: string;
  readonly number: number;
  /** The URL exactly as it appeared, with trailing prose punctuation removed. */
  readonly url: string;
}

/** github.com itself, or one of its subdomains (e.g. `www.github.com`). A
    lookalike like `github.evil.com` is rejected — matching by a `github.`
    prefix would accept it. Enterprise installs are out of scope (see module
    doc). */
function isGitHubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname.endsWith(".github.com");
}

// URLs in prose and tool output run until whitespace or a delimiter that cannot
// be part of a PR URL — a closing bracket/paren (markdown `](...)`), a quote, an
// angle bracket, or a backtick. Trailing sentence punctuation is stripped after.
const URL_CANDIDATE = /https?:\/\/[^\s"'<>`)\]}]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;
const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/u;

/**
 * The last GitHub pull request URL in `text`, or null when there is none. Each
 * candidate URL is parsed with the URL constructor so trailing path segments
 * (`/pull/42/files`), a query string, or a fragment do not defeat the match,
 * and a lookalike host is rejected by hostname rather than by spelling.
 */
export function extractPullRequestReference(text: string): PullRequestReference | null {
  if (typeof text !== "string" || text.length === 0) return null;

  let found: PullRequestReference | null = null;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, "");
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const host = url.hostname.toLowerCase();
    if (!isGitHubHost(host)) continue;
    const parts = PULL_PATH.exec(url.pathname);
    if (!parts) continue;
    const owner = parts[1];
    const repo = parts[2];
    const number = Number(parts[3]);
    if (!owner || !repo || !Number.isSafeInteger(number) || number <= 0) continue;
    // Keep scanning; the last valid match is the most recent PR the text names.
    found = {
      host,
      repository: `${owner}/${repo}`.toLowerCase(),
      number,
      url: candidate,
    };
  }
  return found;
}

/**
 * The repository string to store for a detected PR against a project, or null
 * when the detection should be skipped.
 *
 *   - A known project repository must match the detected one (case-insensitive)
 *     or the detection is dropped — a PR from another repo pasted into the
 *     thread is not the thread's PR (returns null).
 *   - On a match the project's own spelling is returned, so the stored value is
 *     identical to the manual-link path rather than the lower-cased detection.
 *   - When the project repository is unknown the detection is allowed and the
 *     detected repository (lower-cased) is used as-is.
 */
export function resolveLinkedRepository(
  detectedRepository: string,
  projectRepository: string | null,
): string | null {
  if (projectRepository === null) return detectedRepository;
  return projectRepository.toLowerCase() === detectedRepository.toLowerCase()
    ? projectRepository
    : null;
}
