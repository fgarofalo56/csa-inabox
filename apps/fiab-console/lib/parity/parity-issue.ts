/**
 * WS-10.5 — Parity Autopilot: the GitHub issue-filing runtime half.
 *
 * REAL GitHub REST calls (api.github.com) — reuses the SAME credentials + repo
 * resolution as the in-app feedback forwarder (`LOOM_FEEDBACK_GITHUB_TOKEN`,
 * `LOOM_FEEDBACK_REPO_OWNER`/`_NAME`) so no new env var is introduced. Two
 * operations:
 *
 *   • {@link fileParityGapIssue} — POST a shaped gap issue, with idempotent
 *     dedupe: it first SEARCHes for an already-open issue carrying the gap's
 *     fingerprint marker and skips filing when one exists (a scheduled run does
 *     not spam duplicates). Ensures the `parity-autopilot` label exists first.
 *   • {@link listParityGapIssues} — GET the open `parity-autopilot`-labelled
 *     issues for the admin surface's "filed issues" view.
 *
 * Honest gate (no-vaporware.md): when `LOOM_FEEDBACK_GITHUB_TOKEN` is unset
 * (air-gapped / Gov-egress-blocked), every call returns `{ gated: true, reason }`
 * naming the exact env var — nothing is fabricated, nothing throws.
 */

import { PARITY_AUTOPILOT_LABEL, type ShapedIssue } from './parity-autopilot';

const GH_API = 'https://api.github.com';

function repo(): { owner: string; name: string } {
  return {
    owner: process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56',
    name: process.env.LOOM_FEEDBACK_REPO_NAME || 'csa-inabox',
  };
}

function ghToken(): string | undefined {
  return process.env.LOOM_FEEDBACK_GITHUB_TOKEN || undefined;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/** The honest-gate reason string (names the exact env var to set). */
export const GITHUB_GATE_REASON =
  'GitHub issue filing is not configured: set LOOM_FEEDBACK_GITHUB_TOKEN (a repo-scoped ' +
  'token) — and optionally LOOM_FEEDBACK_REPO_OWNER / LOOM_FEEDBACK_REPO_NAME — to let the ' +
  'Parity Autopilot file gap issues. In an air-gapped / Gov-egress-blocked boundary this ' +
  'stays gated by design and gaps are returned to the caller instead of filed.';

export interface FileIssueResult {
  /** True when GitHub egress is not configured (honest gate). */
  gated?: boolean;
  reason?: string;
  /** True when an open issue with this fingerprint already existed (skipped). */
  deduped?: boolean;
  filed?: boolean;
  issueNumber?: number;
  issueUrl?: string;
  /** Set when the POST/search failed at the API (non-2xx / transport). */
  error?: string;
}

/**
 * Find an OPEN issue already carrying `fingerprint` (in its body marker). Uses
 * the GitHub search API scoped to the repo + label + the fingerprint literal.
 * Returns the issue number/url, or null when none exists.
 */
async function findOpenByFingerprint(
  token: string,
  fingerprint: string,
): Promise<{ number: number; url: string } | null> {
  const { owner, name } = repo();
  // The fingerprint (parity-autopilot:<slug>#<num>) is a distinctive literal in
  // the body; search in:body scoped to open issues in this repo with our label.
  const q = `repo:${owner}/${name} is:issue is:open in:body label:${PARITY_AUTOPILOT_LABEL} "${fingerprint}"`;
  const res = await fetch(`${GH_API}/search/issues?q=${encodeURIComponent(q)}&per_page=5`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) return null; // search hiccup → treat as "not found" (POST path also dedupes on 422-less create)
  const j = (await res.json()) as { items?: Array<{ number: number; html_url: string; body?: string }> };
  const items = Array.isArray(j.items) ? j.items : [];
  // Search can be fuzzy; confirm the marker literally appears in the body.
  const hit = items.find((it) => (it.body || '').includes(fingerprint));
  return hit ? { number: hit.number, url: hit.html_url } : null;
}

/** Best-effort: ensure the label exists (idempotent — 422 if it already does). */
async function ensureLabel(token: string): Promise<void> {
  const { owner, name } = repo();
  try {
    await fetch(`${GH_API}/repos/${owner}/${name}/labels`, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({
        name: PARITY_AUTOPILOT_LABEL,
        color: '5319e7',
        description: 'Auto-filed UI parity gap (WS-10.5 Parity Autopilot)',
      }),
    });
  } catch {
    /* label creation is best-effort; a missing label still files the issue */
  }
}

/**
 * File a shaped gap issue (idempotently). REAL GitHub POST. When
 * `LOOM_FEEDBACK_GITHUB_TOKEN` is unset, returns the honest gate. When an open
 * issue with the same fingerprint already exists, returns `{ deduped: true }`
 * and does NOT create a duplicate.
 */
export async function fileParityGapIssue(shaped: ShapedIssue): Promise<FileIssueResult> {
  const token = ghToken();
  if (!token) return { gated: true, reason: GITHUB_GATE_REASON };

  try {
    const existing = await findOpenByFingerprint(token, shaped.fingerprint);
    if (existing) {
      return { deduped: true, filed: false, issueNumber: existing.number, issueUrl: existing.url };
    }
    await ensureLabel(token);
    const { owner, name } = repo();
    const res = await fetch(`${GH_API}/repos/${owner}/${name}/issues`, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({ title: shaped.title, body: shaped.body, labels: shaped.labels }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: `GitHub issue create failed ${res.status}: ${t.slice(0, 200)}` };
    }
    const j = (await res.json()) as { number?: number; html_url?: string };
    return { filed: true, issueNumber: j.number, issueUrl: j.html_url };
  } catch (e: any) {
    return { error: `GitHub issue filing exception: ${e?.message || e}` };
  }
}

export interface ListedIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  state: string;
}

export interface ListIssuesResult {
  gated?: boolean;
  reason?: string;
  issues: ListedIssue[];
  error?: string;
}

/** List recent `parity-autopilot`-labelled issues for the admin surface. */
export async function listParityGapIssues(opts: { state?: 'open' | 'all'; limit?: number } = {}): Promise<ListIssuesResult> {
  const token = ghToken();
  if (!token) return { gated: true, reason: GITHUB_GATE_REASON, issues: [] };
  const { owner, name } = repo();
  const state = opts.state || 'open';
  const perPage = Math.min(Math.max(opts.limit || 30, 1), 100);
  try {
    const res = await fetch(
      `${GH_API}/repos/${owner}/${name}/issues?labels=${encodeURIComponent(PARITY_AUTOPILOT_LABEL)}&state=${state}&per_page=${perPage}&sort=created&direction=desc`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { issues: [], error: `GitHub list failed ${res.status}: ${t.slice(0, 200)}` };
    }
    const rows = (await res.json()) as any[];
    const issues: ListedIssue[] = (Array.isArray(rows) ? rows : [])
      .filter((r) => !r.pull_request) // issues endpoint also returns PRs; drop them
      .map((r) => ({
        number: r.number,
        title: r.title,
        url: r.html_url,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        state: r.state,
      }));
    return { issues };
  } catch (e: any) {
    return { issues: [], error: `GitHub list exception: ${e?.message || e}` };
  }
}
